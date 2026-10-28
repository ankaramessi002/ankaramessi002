import { appendFileSync } from 'node:fs';

const originalFetch = globalThis.fetch;

globalThis.fetch = async (input, options) => {
  const url = new URL(input);
  if (url.hostname !== 'www.erome.com') return originalFetch(input, options);

  appendFileSync(process.env.TEST_UPSTREAM_LOG, `${url.href}\n`);
  return new Response('<!doctype html><html><head><title>Empty upstream page</title></head><body></body></html>', {
    status: 200,
    headers: { 'content-type': 'text/html; charset=utf-8' },
  });
};
