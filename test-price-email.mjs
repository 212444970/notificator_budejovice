import assert from 'node:assert/strict';
import { aggregate, buildEmailBody } from './scrape-and-notify.mjs';

const current = {
  '1KK': { total: 4, available: 2, sold: 1, reserved: 1, avgPricePerSqm: 72000 },
  '2KK': { total: 6, available: 3, sold: 2, reserved: 1, avgPricePerSqm: 68000 },
};

const email = buildEmailBody(current);
assert.match(email, /Počet volných 1KK 2\/4.*prům\. cena za m²: 72\s*000 Kč/i);
assert.match(email, /Počet volných 2KK 3\/6.*prům\. cena za m²: 68\s*000 Kč/i);
console.log('TEST_OK');
console.log(email);
