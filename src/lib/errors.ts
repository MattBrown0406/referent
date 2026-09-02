export class StoreError extends Error {
  queued: boolean;

  constructor(message: string, queued: boolean) {
    super(message);
    this.name = 'StoreError';
    this.queued = queued;
  }
}

// The remote mutation committed, but the account/workspace changed before the
// caller could safely apply local state. Callers must not compensate by
// deleting remote files or rows in this state.
export class CommittedWriteError extends Error {
  constructor() {
    super('The save completed, but the active account changed before the app refreshed.');
    this.name = 'CommittedWriteError';
  }
}

export class CommittedUploadError extends Error {
  storagePath: string;

  constructor(storagePath: string) {
    super('The upload completed, but the active account changed before the app refreshed.');
    this.name = 'CommittedUploadError';
    this.storagePath = storagePath;
  }
}
