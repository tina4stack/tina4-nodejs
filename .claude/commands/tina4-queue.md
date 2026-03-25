# Set Up Tina4 Background Queue

Set up a DB-backed job queue for background processing. Use this for any operation that takes more than ~1 second.

## Instructions

1. Create a route that pushes work to the queue
2. Create a worker that processes jobs
3. The queue table (`tina4_queue`) is auto-created

## Producer (in route)

```typescript
import { Router, Queue, Producer } from "tina4-nodejs";

Router.post("/api/reports/generate", async (req, res) => {
    const queue = new Queue({ topic: "reports" });
    const producer = new Producer(queue);
    producer.produce({
        userId: req.body.userId,
        type: "monthly",
    });
    return res.json({ status: "queued" });
});
```

## Consumer (separate worker)

Create `worker.ts`:
```typescript
import { Queue, Consumer, Job } from "tina4-nodejs";

function handleReport(job: Job) {
    const data = job.data;
    // Do slow work here...
    const report = generatePdf(data.userId, data.type);
    sendEmail(data.userId, report);
    job.complete();
}

const queue = new Queue({ topic: "reports", callback: handleReport });
const consumer = new Consumer(queue);
consumer.runForever();
```

Run: `npx tsx worker.ts`

## Queue Features

```typescript
import { Queue, Producer, Consumer, Job } from "tina4-nodejs";

const queue = new Queue({ topic: "emails" });

// Push with priority (lower = higher priority)
const producer = new Producer(queue);
producer.produce({ to: "user@test.com" });                    // default priority
producer.produce({ to: "vip@test.com" }, { priority: 1 });    // high priority

// Delayed jobs
producer.produce({ action: "reminder" }, { delaySeconds: 3600 }); // run in 1 hour

// Pop a single job
const job = queue.pop();
if (job) {
    process(job.data);
    job.complete();       // mark done
    // or: job.fail("reason")
    // or: job.retry()
}

// Queue management
queue.size();                    // pending job count
queue.retryFailed();             // retry all failed jobs
queue.deadLetters();             // list permanently failed jobs
queue.purge();                   // delete all completed jobs
```

## When to Use Queues

- Sending emails or SMS
- Generating PDFs/reports
- Calling slow external APIs
- Processing uploaded files (image resize, CSV import)
- Any operation the user should not wait for
