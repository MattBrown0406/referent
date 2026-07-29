export class StoreError extends Error {
  queued: boolean;

  constructor(message: string, queued: boolean) {
    super(message);
    this.name = 'StoreError';
    this.queued = queued;
  }
}
