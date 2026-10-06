import {test} from 'node:test';
import assert from 'node:assert/strict';
import {legacyPayout} from './rollback-compat.js';
test('old orders without fees keep their collected payout', () => assert.equal(legacyPayout(6500),6500));
test('existing funded orders retain all agreed deductions', () => assert.equal(legacyPayout(10000,{service_fee:1000,processing_fee_customer:200,processing_fee_rider:300,delivery_commission:500}),8000));
test('deductions cannot create a negative payout', () => assert.equal(legacyPayout(100,{service_fee:200}),0));
