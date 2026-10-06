import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync,readdirSync} from 'node:fs';
import {join} from 'node:path';
import {createClient,type InArgs} from '@libsql/client/node';
import {Hono} from 'hono';
import {setD1Binding,type D1Database} from '../db/client.js';
import {splitSqlStatements} from '../db/split-sql.js';
import {signToken} from '../auth/jwt.js';
import {walletRoutes} from '../wallet/routes.js';
import {orderRoutes} from '../orders/routes.js';
import {creditWallet} from '../wallet/service.js';

test('restored API preserves modern schema, wallet ownership and sandbox isolation',async () => {
 const client=createClient({url:'file::memory:'});
 for(const file of readdirSync('src/db/migrations').filter(f=>f.endsWith('.sql')).sort()) {
  for(const sql of splitSqlStatements(readFileSync(join('src/db/migrations',file),'utf8'))) await client.execute(sql);
 }
 setD1Binding({prepare(sql:string){return {args:[] as unknown[],bind(...args:unknown[]){this.args=args;return this;},async all(){const r=await client.execute({sql,args:this.args as InArgs});return {results:r.rows,success:true,meta:{changes:r.rowsAffected,last_row_id:Number(r.lastInsertRowid??0)}};}};}} as unknown as D1Database);
 const previousSecret=process.env.JWT_SECRET;process.env.JWT_SECRET='rollback-tests-only';
 try {
  await client.execute("INSERT INTO users (id,phone,name,password_hash,role,wallet_balance,wallet_balance_sandbox) VALUES ('customer','customer','Customer','hash','customer',10000,20000),('owner','owner','Owner','hash','customer',30000,40000)");
  await client.execute("INSERT INTO settings(key,value) VALUES('platform_environment','sandbox')");
  await client.execute("INSERT INTO wallets(id,owner_id,name,balance,balance_sandbox) VALUES('secondary','owner','Secondary',5000,6000)");
  await client.execute("INSERT INTO wallet_shares(id,owner_id,grantee_id,status,wallet_id) VALUES('share','owner','customer','active','secondary')");
  await client.execute("INSERT INTO lists(id,customer_id,title,status,environment) VALUES('list','customer','Test','draft','sandbox')");
  await client.execute("INSERT INTO orders(id,list_id,customer_id,stage,type,estimated_total,environment) VALUES('order','list','customer','Match','parcel',1000,'sandbox')");
  const token=await signToken({sub:'customer',role:'customer'});
  const app=new Hono();app.route('/v1',orderRoutes);app.route('/v1',walletRoutes);
  const headers={Authorization:`Bearer ${token}`,'Content-Type':'application/json'};
  const shares=await (await app.request('/v1/wallet/shares',{headers})).json();
  assert.equal(shares.received.length,0,'secondary share must not expose the primary balance');
  const denied=await app.request('/v1/orders/order/fund',{method:'POST',headers,body:JSON.stringify({paymentMethod:'wallet',useWallet:true,walletOwnerId:'owner'})});
  assert.equal(denied.status,403);
  await creditWallet('customer',1000,{type:'topup',environment:'sandbox'});
  const row=(await client.execute("SELECT wallet_balance,wallet_balance_sandbox FROM users WHERE id='customer'")).rows[0];
  assert.deepEqual([row.wallet_balance,row.wallet_balance_sandbox],[10000,21000]);
  assert.equal((await client.execute("SELECT balance FROM wallets WHERE id='secondary'")).rows[0].balance,5000);
  const wallet=await (await app.request('/v1/wallet',{headers})).json();
  assert.equal(wallet.balance,21000);
  assert.equal(wallet.ledger[0].environment,'sandbox');
 } finally {setD1Binding(undefined);client.close();if(previousSecret===undefined)delete process.env.JWT_SECRET;else process.env.JWT_SECRET=previousSecret;}
});
