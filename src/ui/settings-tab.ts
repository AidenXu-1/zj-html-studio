import {
  Modal,
  Notice,
  PluginSettingTab,
  Setting,
  type App,
  type ButtonComponent,
  type SettingDefinitionItem
} from "obsidian";
import type HtmlStudioPlugin from "../main";
import type { PreviewMode } from "../settings";

const MODE_LABELS: Record<PreviewMode, string> = {
  safe: "安全只读",
  interactive: "本地交互",
  trusted: "可信兼容"
};

export class HtmlStudioSettingTab extends PluginSettingTab {
  constructor(app: App, private readonly plugin: HtmlStudioPlugin) {
    super(app, plugin);
  }

  override getSettingDefinitions(): SettingDefinitionItem[] {
    const rules = this.getRules();
    return [
      {
        type: "group",
        heading: "预览与权限",
        items: [
          {
            name: "自动刷新",
            desc: "HTML 或已识别依赖发生变化时自动重新分析并刷新对应预览。",
            control: { key: "autoReload", type: "toggle" }
          },
          {
            name: "文件夹权限如何生效",
            desc: "规则只决定 HTML 的默认打开方式，不扩大本地资源范围。更具体的子规则优先；删除单条规则不打断独立浏览器会话，全部重置会立即撤销。"
          }
        ]
      },
      {
        type: "list",
        heading: "已记住的文件夹权限",
        emptyState: "目前没有已记住的规则，HTML 默认使用安全只读。",
        items: rules.map(rule => ({
          name: rule.scopePath,
          desc: `${MODE_LABELS[rule.mode]} · 影响这个文件夹及其没有更具体规则的子文件夹`
        })),
        onDelete: index => {
          const rule = rules[index];
          if (!rule) return;
          void this.plugin.removeScopeMode(rule.scopePath, rule.mode).then(() => this.refreshDefinitions());
        }
      },
      {
        type: "group",
        items: [{
          name: "恢复全部安全默认",
          desc: "删除全部已记住规则，撤销系统浏览器会话，并立即把仍在运行的本地交互或可信页面降为安全只读。",
          action: () => {
            void this.confirmAndReset(() => this.refreshDefinitions());
          }
        }]
      }
    ];
  }

  override getControlValue(key: string): unknown {
    return key === "autoReload" ? this.plugin.settings.autoReload : undefined;
  }

  override async setControlValue(key: string, value: unknown): Promise<void> {
    if (key === "autoReload" && typeof value === "boolean") {
      await this.plugin.setAutoReload(value);
    }
  }

  override display(): void {
    this.renderLegacySettings();
  }

  private renderLegacySettings(): void {
    const { containerEl } = this;
    containerEl.empty();
    new Setting(containerEl).setName("预览与权限").setHeading();

    new Setting(containerEl)
      .setName("自动刷新")
      .setDesc("HTML 或已识别依赖发生变化时自动重新分析并刷新对应预览。")
      .addToggle(toggle => toggle
        .setValue(this.plugin.settings.autoReload)
        .onChange(async enabled => {
          await this.plugin.setAutoReload(enabled);
        }));

    new Setting(containerEl).setName("已记住的文件夹权限").setHeading();
    containerEl.createEl("p", {
      text: "规则只决定文件夹内 HTML 的默认打开方式，不决定页面能读取多大的资源范围。规则会应用到子文件夹，更具体的子规则优先。删除单条规则不打断已明确授权的系统浏览器会话；全部重置会立即撤销这些会话。"
    });

    const rules = this.getRules();
    if (rules.length === 0) {
      containerEl.createEl("p", { text: "目前没有已记住的规则，HTML 默认使用安全只读。" });
    } else {
      for (const rule of rules) {
        new Setting(containerEl)
          .setName(rule.scopePath)
          .setDesc(`${MODE_LABELS[rule.mode]} · 影响这个文件夹及其没有更具体规则的子文件夹`)
          .addButton(button => {
            button.setButtonText("删除规则");
            styleDestructiveButton(button);
            button.onClick(async () => {
              await this.plugin.removeScopeMode(rule.scopePath, rule.mode);
              this.renderLegacySettings();
            });
          });
      }
    }

    new Setting(containerEl)
      .setName("恢复全部安全默认")
      .setDesc("删除全部已记住规则，撤销系统浏览器会话，并立即把仍在运行的本地交互或可信页面降为安全只读。")
      .addButton(button => {
        button.setButtonText("全部重置");
        styleDestructiveButton(button);
        button.onClick(async () => {
          await this.confirmAndReset(() => this.renderLegacySettings());
        });
      });
  }

  private async confirmAndReset(refresh: () => void): Promise<void> {
    const confirmed = await new ConfirmPermissionResetModal(this.app).waitForDecision();
    if (!confirmed) return;
    await this.plugin.resetScopeModes();
    new Notice("已删除全部文件夹权限，运行中的页面已按安全只读重新检查。");
    refresh();
  }

  private refreshDefinitions(): void {
    const update = (this as unknown as { update?: () => void }).update;
    update?.call(this);
  }

  private getRules(): Array<{ mode: PreviewMode; scopePath: string }> {
    return [
      ...this.plugin.settings.safeScopes.map(scopePath => ({ mode: "safe" as const, scopePath })),
      ...this.plugin.settings.interactiveScopes.map(scopePath => ({ mode: "interactive" as const, scopePath })),
      ...this.plugin.settings.trustedScopes.map(scopePath => ({ mode: "trusted" as const, scopePath }))
    ].sort((left, right) => left.scopePath.localeCompare(right.scopePath)
      || MODE_LABELS[left.mode].localeCompare(MODE_LABELS[right.mode]));
  }
}

function styleDestructiveButton(button: ButtonComponent): void {
  const compatibleButton = button as Omit<ButtonComponent, "setDestructive" | "setWarning"> & {
    setDestructive?: () => ButtonComponent;
    setWarning?: () => ButtonComponent;
  };
  const setDestructive = compatibleButton["setDestructive"];
  if (typeof setDestructive === "function") {
    setDestructive.call(button);
    return;
  }
  compatibleButton["setWarning"]?.call(button);
}

class ConfirmPermissionResetModal extends Modal {
  private resolveDecision: ((confirmed: boolean) => void) | null = null;
  private settled = false;

  waitForDecision(): Promise<boolean> {
    return new Promise(resolve => {
      this.resolveDecision = resolve;
      this.open();
    });
  }

  override onOpen(): void {
    this.setTitle("恢复全部安全默认？");
    this.contentEl.createEl("p", {
      text: "这会删除全部文件夹权限规则，撤销系统浏览器会话，并立即停止仍在运行的本地交互或可信页面，再按安全只读重新打开。这个操作不会修改任何 HTML 文件。"
    });
    const actions = this.contentEl.createDiv({ cls: "html-studio-trust-actions" });
    const cancel = actions.createEl("button", { text: "取消" });
    cancel.addEventListener("click", () => this.settle(false));
    const confirm = actions.createEl("button", { cls: "mod-warning", text: "全部重置" });
    confirm.addEventListener("click", () => this.settle(true));
  }

  override onClose(): void {
    this.settle(false, false);
    this.contentEl.empty();
  }

  private settle(confirmed: boolean, close = true): void {
    if (this.settled) return;
    this.settled = true;
    this.resolveDecision?.(confirmed);
    this.resolveDecision = null;
    if (close) this.close();
  }
}
