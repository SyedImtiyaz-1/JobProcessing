// Tiny pub/sub used to push job lifecycle events to SSE subscribers.
// Topics: a per-job topic (`job:<id>`) and a firehose (`*`) for the dashboard.

import { EventEmitter } from 'node:events';

class JobEventBus extends EventEmitter {
  publish(event) {
    // event: { jobId, status, ... }
    this.emit(`job:${event.jobId}`, event);
    this.emit('*', event);
  }
}

export const bus = new JobEventBus();
bus.setMaxListeners(0); // many SSE clients may subscribe to the firehose
