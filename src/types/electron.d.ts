declare module "electron" {
  export const remote: {
    screen?: import("../presentation/projection-display").PresentationScreen;
    BrowserWindow?: import("../presentation/native-window").NativeWindowRegistry<
      import("../presentation/projection-display").PresentationWindow & {
        webContents?: import("../presentation/picture-projection").CaptureContents;
      }
    >;
  } | undefined;
  export const shell: {
    openExternal(url: string): Promise<void>;
    showItemInFolder(fullPath: string): void;
  };
}
