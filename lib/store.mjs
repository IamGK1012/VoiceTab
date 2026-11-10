import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { RequestError, seedMenu } from './menu.mjs';

export function openStore(path) {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS orders (
      number INTEGER PRIMARY KEY AUTOINCREMENT,
      id TEXT NOT NULL UNIQUE,
      document TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS menu_items (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      aliases TEXT NOT NULL,
      description TEXT NOT NULL,
      cents INTEGER NOT NULL CHECK (cents >= 0),
      icon TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS checkout_links (
      order_id TEXT PRIMARY KEY,
      token TEXT NOT NULL UNIQUE,
      version INTEGER NOT NULL,
      expires_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS stall_brand (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      document TEXT NOT NULL
    );
  `);
  const insertMenu = db.prepare('INSERT OR IGNORE INTO menu_items (id, name, aliases, description, cents, icon) VALUES (?, ?, ?, ?, ?, ?)');
  for (const { id, name, aliases, description, cents, icon } of seedMenu) {
    insertMenu.run(id, name, JSON.stringify(aliases), description, cents, icon);
  }
  const readMenu = db.prepare('SELECT * FROM menu_items ORDER BY rowid');
  const readBrand = db.prepare('SELECT document FROM stall_brand WHERE id = 1');
  const writeBrand = db.prepare(`
    INSERT INTO stall_brand VALUES (1, ?)
    ON CONFLICT(id) DO UPDATE SET document = excluded.document
  `);
  const get = db.prepare('SELECT number, document FROM orders WHERE id = ?');
  const list = db.prepare(`
    SELECT number, document FROM orders
    WHERE json_extract(document, '$.status') IN ('draft', 'checkout', 'payment_pending')
      OR (json_extract(document, '$.status') = 'paid' AND json_extract(document, '$.servedAt') IS NULL)
      OR number IN (SELECT number FROM orders ORDER BY number DESC LIMIT 30)
    ORDER BY number DESC
  `);
  const paid = db.prepare("SELECT number, document FROM orders WHERE json_extract(document, '$.status') = 'paid'");
  const insert = db.prepare('INSERT INTO orders (id, document) VALUES (?, ?)');
  const update = db.prepare('UPDATE orders SET document = ? WHERE id = ?');
  const getLink = db.prepare('SELECT * FROM checkout_links WHERE order_id = ?');
  const findLink = db.prepare('SELECT * FROM checkout_links WHERE token = ?');
  const putLink = db.prepare(`
    INSERT INTO checkout_links (order_id, token, version, expires_at) VALUES (?, ?, ?, ?)
    ON CONFLICT(order_id) DO UPDATE SET token = excluded.token, version = excluded.version, expires_at = excluded.expires_at
  `);
  const read = row => ({ ...JSON.parse(row.document), number: row.number });
  const inFlight = new Set();

  return {
    linkFor(order, now, lifetime) {
      const current = getLink.get(order.id);
      if (current && (order.checkoutTicket === current.token ||
        (current.version === order.version && current.expires_at > now))) return current;
      putLink.run(order.id, randomUUID(), order.version, now + lifetime);
      return getLink.get(order.id);
    },
    findLink(token) {
      return findLink.get(token);
    },
    menu() {
      return readMenu.all().map(item => ({ ...item, aliases: JSON.parse(item.aliases) }));
    },
    brand() {
      const row = readBrand.get();
      return row && JSON.parse(row.document);
    },
    saveBrand(brand) {
      writeBrand.run(JSON.stringify(brand));
      return brand;
    },
    create() {
      const id = randomUUID();
      insert.run(id, JSON.stringify({ id, version: 1, status: 'draft', lines: [], createdAt: new Date().toISOString() }));
      return this.get(id);
    },
    get(id) {
      const row = get.get(id);
      if (!row) throw new RequestError(404, 'Order not found.');
      return read(row);
    },
    list() {
      return list.all().map(read);
    },
    paid() {
      return paid.all().map(read);
    },
    save(order) {
      order.version += 1;
      update.run(JSON.stringify(order), order.id);
      return order;
    },
    async run(id, fn) {
      if (inFlight.has(id)) throw new RequestError(409, 'This order is updating. Wait a moment and try again.');
      inFlight.add(id);
      try {
        return await fn(this.get(id));
      } finally {
        inFlight.delete(id);
      }
    },
  };
}
