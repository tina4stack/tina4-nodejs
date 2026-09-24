/*
Copyright (c) 2026 Code Infinity
SPDX-License-Identifier: MPL-2.0
This Source Code Form is subject to the terms of the Mozilla Public
License, v. 2.0. If a copy of the MPL was not distributed with this
file, You can obtain one at https://mozilla.org/MPL/2.0/.
*/

/** Real PostgreSQL regression for exclusive operation/transaction leases. */
import assert from 'node:assert/strict';
import { AsyncResource } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { Database } from '../packages/orm/src/database.js';

let passed = 0, failed = 0;
async function check(name: string, fn: () => Promise<void>) {
  try { await fn(); passed++; console.log(`PASS ${name}`); }
  catch (error) { failed++; console.error(`FAIL ${name}`, error); }
}
const url = process.env.TINA4_TEST_PG_URL;
if (!url) {
  console.log('SKIP [needs:postgres] TINA4_TEST_PG_URL is not configured');
} else {
  await check('pool transaction lease prevents cross context dirty reads and lost writes', async () => {
    const db = await Database.create(url, undefined, undefined, 4);
    const outside = new AsyncResource('pool-isolation-outsider');
    const table = 'pool145_' + randomUUID().replaceAll('-', '');
    try {
      await db.execute(`CREATE TABLE ${table} (id INTEGER PRIMARY KEY)`);
      await db.startTransaction();
      await db.execute(`INSERT INTO ${table} VALUES (1)`);
      let counts: number[] = [];
      try {
        counts = await outside.runInAsyncScope(async () => {
          const result = [];
          for (let i=0; i<8; i++) result.push(Number((await db.fetchOne<{ n: string }>(`SELECT COUNT(*) AS n FROM ${table}`))!.n));
          for (let i=100; i<104; i++) await db.execute(`INSERT INTO ${table} VALUES (?)`, [i]);
          return result;
        });
      } finally { await db.rollback(); }
      assert.deepEqual(counts, Array(8).fill(0));
      assert.deepEqual((await db.fetchAll<{id: number}>(`SELECT id FROM ${table} ORDER BY id`)).map(row => row.id), [100,101,102,103]);
    } finally { await db.execute(`DROP TABLE IF EXISTS ${table}`); db.close(); outside.emitDestroy(); }
  });
  await check('pool exhaustion fails without sharing a live transaction', async () => {
    const db = await Database.create(url, undefined, undefined, 1);
    const outside = new AsyncResource('pool-one-outsider');
    try {
      await db.startTransaction();
      try {
        await assert.rejects(outside.runInAsyncScope(() => db.fetchOne('SELECT 1 AS n')), /pool exhausted/);
        assert.throws(() => outside.runInAsyncScope(() => db.getAdapter()), /pool exhausted/);
      } finally { await db.rollback(); }
      assert.equal((await db.fetchOne<{n:number}>('SELECT 1 AS n'))!.n, 1);
    } finally { db.close(); outside.emitDestroy(); }
  });
  await check('ordinary async operation reserves its connection', async () => {
    const db = await Database.create(url, undefined, undefined, 1);
    try {
      const slow = db.fetchOne('SELECT pg_sleep(0.1)');
      await assert.rejects(db.fetchOne('SELECT 1 AS n'), /pool exhausted/);
      await slow;
      assert.equal((await db.fetchOne<{n:number}>('SELECT 1 AS n'))!.n, 1);
    } finally { db.close(); }
  });
  await check('explicit leases require their borrowing context', async () => {
    const db = await Database.create(url, undefined, undefined, 1);
    const outside = new AsyncResource('explicit-lease-outsider');
    try {
      const adapter = db.checkout();
      try {
        assert.throws(() => outside.runInAsyncScope(() => db.checkin(adapter)), /owner mismatch/);
        assert.throws(() => db.checkout(), /pool exhausted/);
      } finally { db.checkin(adapter); }
      assert.equal((await db.fetchOne<{n:number}>('SELECT 1 AS n'))!.n, 1);
    } finally { db.close(); outside.emitDestroy(); }
  });
  await check('pool failed commit retains lease until rollback', async () => {
    const db = await Database.create(url, undefined, undefined, 1);
    const outside = new AsyncResource('failed-commit-outsider');
    const table = 'pool145_' + randomUUID().replaceAll('-', '');
    try {
      await db.execute(`CREATE TABLE ${table} (id INTEGER UNIQUE DEFERRABLE INITIALLY DEFERRED)`);
      await db.startTransaction();
      await db.execute(`INSERT INTO ${table} VALUES (1), (1)`);
      await assert.rejects(db.commit());
      await assert.rejects(outside.runInAsyncScope(() => db.fetchOne('SELECT 1')), /pool exhausted/);
      await db.rollback();
      assert.equal(Number((await db.fetchOne<{n:string}>(`SELECT COUNT(*) AS n FROM ${table}`))!.n), 0);
      await db.startTransaction();
      await db.execute(`INSERT INTO ${table} VALUES (2)`);
      await db.commit();
      assert.equal(Number((await db.fetchOne<{n:string}>(`SELECT COUNT(*) AS n FROM ${table}`))!.n), 1);
    } finally { await db.execute(`DROP TABLE IF EXISTS ${table}`); db.close(); outside.emitDestroy(); }
  });
  await check('query failure releases ordinary connection', async () => {
    const db = await Database.create(url, undefined, undefined, 1);
    try {
      await assert.rejects(db.execute('SELECT column_that_does_not_exist'));
      assert.equal((await db.fetchOne<{n:number}>('SELECT 1 AS n'))!.n, 1);
    } finally { db.close(); }
  });
  await check('failed begin discards connection and restores capacity', async () => {
    const db = await Database.create(url, undefined, undefined, 1);
    try {
      const adapter = db.checkout(); adapter.close(); db.checkin(adapter);
      await assert.rejects(db.startTransaction());
      await db.startTransaction();
      await db.rollback();
      assert.equal((await db.fetchOne<{n:number}>('SELECT 1 AS n'))!.n, 1);
    } finally { db.close(); }
  });
  await check('failed rollback discards connection and restores capacity', async () => {
    const db = await Database.create(url, undefined, undefined, 1);
    try {
      await db.startTransaction(); db.getAdapter().close();
      await assert.rejects(db.rollback());
      assert.equal((await db.fetchOne<{n:number}>('SELECT 1 AS n'))!.n, 1);
    } finally { db.close(); }
  });

}
console.log(`${passed} passed, ${failed} failed`);
if (failed) process.exitCode = 1;
