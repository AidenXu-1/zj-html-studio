export class PreviewCandidateReadiness {
  private bridgeReadyAfterLoad = false;
  private iframeLoaded = false;
  private requiresBridge: boolean | null = null;
  private restoreReady = false;
  private ticketReady = false;

  constructor(private readonly requiresRestore: boolean) {}

  get ready(): boolean {
    return this.iframeLoaded
      && this.ticketReady
      && this.requiresBridge !== null
      && (!this.requiresBridge || this.bridgeReadyAfterLoad)
      && (!this.requiresBridge || !this.requiresRestore || this.restoreReady);
  }

  get canSendRestore(): boolean {
    return this.requiresBridge === true
      && this.iframeLoaded
      && this.bridgeReadyAfterLoad
      && this.requiresRestore;
  }

  configureBridgeRequirement(required: boolean): void {
    this.requiresBridge = required;
    if (!required) this.restoreReady = true;
  }

  markBridgeReady(): void {
    if (this.iframeLoaded) this.bridgeReadyAfterLoad = true;
    this.restoreReady = !this.requiresRestore;
  }

  markIframeLoaded(): void {
    this.iframeLoaded = true;
    // A bridge created before the final iframe load may belong to a document
    // that immediately navigated away. Require the post-load reconnect.
    this.bridgeReadyAfterLoad = false;
    this.restoreReady = !this.requiresRestore;
  }

  markRestoreReady(): void {
    this.restoreReady = true;
  }

  markTicketReady(): void {
    this.ticketReady = true;
  }
}
