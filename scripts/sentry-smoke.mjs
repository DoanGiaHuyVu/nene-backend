import * as Sentry from '@sentry/node';

if (!Sentry.getClient()) throw new Error('SENTRY_DSN is required');
let accepted = false;
Sentry.getClient().on('afterSendEvent', (_event, response) => {
  accepted = !!response && response.statusCode >= 200 && response.statusCode < 300;
});
const eventId = Sentry.captureMessage('ne-ne Sentry setup test');
const flushed = await Sentry.flush(5000);
console.log(JSON.stringify({ eventId, flushed, accepted }));
await Sentry.close(1000);
if (!accepted || !flushed) process.exitCode = 1;
