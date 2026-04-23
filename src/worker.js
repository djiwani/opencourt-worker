/**
 * OpenCourt Worker
 *
 * Continuously polls SQS for checkin/checkout events and processes
 * user stats, badges, and leaderboard updates in real time.
 */

const { SQSClient, ReceiveMessageCommand, DeleteMessageCommand } = require('@aws-sdk/client-sqs');
const { processCheckinEvent } = require('./analytics');

const sqsClient = new SQSClient({ region: process.env.AWS_REGION || 'us-east-1' });

const QUEUE_URL = process.env.SQS_QUEUE_URL;
const POLL_WAIT_SECONDS = 20; // Long polling — reduces empty responses and cost
const MAX_MESSAGES = 10;

if (!QUEUE_URL) {
  console.error('SQS_QUEUE_URL environment variable is required');
  process.exit(1);
}

if (!process.env.DB_SECRET_ARN) {
  console.error('DB_SECRET_ARN environment variable is required');
  process.exit(1);
}

// ── POLL LOOP ─────────────────────────────────────────────────────────────────

async function poll() {
  console.log('OpenCourt Worker started — polling SQS for events...');
  console.log(`Queue: ${QUEUE_URL}`);

  while (true) {
    try {
      const response = await sqsClient.send(new ReceiveMessageCommand({
        QueueUrl:            QUEUE_URL,
        MaxNumberOfMessages: MAX_MESSAGES,
        WaitTimeSeconds:     POLL_WAIT_SECONDS, // Long poll
        AttributeNames:      ['All'],
        MessageAttributeNames: ['All'],
      }));

      const messages = response.Messages || [];

      if (messages.length === 0) {
        // Normal — long poll returned with no messages
        continue;
      }

      console.log(`Received ${messages.length} message(s)`);

      // Process messages concurrently
      await Promise.all(messages.map(async (message) => {
        try {
          const event = JSON.parse(message.Body);
          console.log(`Processing message ${message.MessageId}:`, event.event_type);

          await processCheckinEvent(event);

          // Delete message from queue after successful processing
          await sqsClient.send(new DeleteMessageCommand({
            QueueUrl:      QUEUE_URL,
            ReceiptHandle: message.ReceiptHandle,
          }));

          console.log(`Message ${message.MessageId} processed and deleted`);

        } catch (err) {
          // Don't delete — message will become visible again after visibility timeout
          // and be retried. After maxReceiveCount it goes to the DLQ.
          console.error(`Failed to process message ${message.MessageId}:`, err.message);
        }
      }));

    } catch (err) {
      console.error('SQS poll error:', err.message);
      // Wait before retrying to avoid hammering SQS on persistent errors
      await new Promise(resolve => setTimeout(resolve, 5000));
    }
  }
}

// ── GRACEFUL SHUTDOWN ─────────────────────────────────────────────────────────

process.on('SIGTERM', () => {
  console.log('SIGTERM received — shutting down gracefully');
  process.exit(0);
});

process.on('SIGINT', () => {
  console.log('SIGINT received — shutting down gracefully');
  process.exit(0);
});

// ── START ─────────────────────────────────────────────────────────────────────

poll().catch(err => {
  console.error('Worker crashed:', err.message);
  process.exit(1);
});
