
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { audit } from './logger.js';

// --------------------------------------------------
// Database Configuration
// --------------------------------------------------

const dbPath = path.resolve(
  process.env.DATABASE_PATH || 'data/verdant.db'
);

// Create the database directory if it doesn't exist
fs.mkdirSync(path.dirname(dbPath), { recursive: true });

// Initialize SQLite database connection
export const db = new DatabaseSync(dbPath);

// Enable foreign key constraints
db.exec('PRAGMA foreign_keys = ON;');


// --------------------------------------------------
// Database Schema
// --------------------------------------------------

db.exec(`
  -- Customers table
  CREATE TABLE IF NOT EXISTS customers (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    phone TEXT NOT NULL,
    created_at TEXT NOT NULL
  );

  -- Conversations table
  CREATE TABLE IF NOT EXISTS conversations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    customer_id TEXT NOT NULL UNIQUE
      REFERENCES customers(id),
    status TEXT NOT NULL DEFAULT 'open',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  -- Messages table
  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    external_id TEXT UNIQUE,
    conversation_id INTEGER NOT NULL
      REFERENCES conversations(id),
    sender TEXT NOT NULL
      CHECK(sender IN ('customer', 'agent')),
    text TEXT NOT NULL,
    created_at TEXT NOT NULL
  );

  -- AI Drafts table
  CREATE TABLE IF NOT EXISTS drafts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    message_id INTEGER NOT NULL UNIQUE
      REFERENCES messages(id),
    text TEXT,
    status TEXT NOT NULL
      CHECK(status IN ('pending', 'ready', 'failed', 'used')),
    error TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  -- Webhook Events table
  CREATE TABLE IF NOT EXISTS webhook_events (
    event_id TEXT PRIMARY KEY,
    received_at TEXT NOT NULL
  );
`);


// --------------------------------------------------
// Database Initialization Logging
// --------------------------------------------------

audit('database', 'schema_initialized', {
  database: dbPath
});


// --------------------------------------------------
// Get Customer Conversation
// --------------------------------------------------

export function getConversation(customerId) {
  return db.prepare(`
    SELECT
      c.id AS conversation_id,
      c.updated_at,
      u.id AS customer_id,
      u.name,
      u.phone
    FROM conversations c
    JOIN customers u
      ON u.id = c.customer_id
    WHERE u.id = ?
  `).get(customerId);
}


// --------------------------------------------------
// Get All Conversations
// --------------------------------------------------

export function listConversations() {
  return db.prepare(`
    SELECT
      c.id,
      u.id AS customer_id,
      u.name,
      u.phone,
      c.updated_at,

      (
        SELECT m.text
        FROM messages m
        WHERE m.conversation_id = c.id
        ORDER BY m.created_at DESC, m.id DESC
        LIMIT 1
      ) AS latest_text

    FROM conversations c

    JOIN customers u
      ON u.id = c.customer_id

    ORDER BY c.updated_at DESC
  `).all();
}


// --------------------------------------------------
// Get Conversation Details with Messages and Drafts
// --------------------------------------------------

export function getConversationDetail(id) {

  // Fetch conversation and customer information
  const conversation = db.prepare(`
    SELECT
      c.id,
      u.id AS customer_id,
      u.name,
      u.phone

    FROM conversations c

    JOIN customers u
      ON u.id = c.customer_id

    WHERE c.id = ?
  `).get(id);

  // Return null if conversation does not exist
  if (!conversation) {
    return null;
  }

  // Fetch all messages and their associated AI drafts
  conversation.messages = db.prepare(`
    SELECT
      m.*,
      d.id AS draft_id,
      d.text AS draft_text,
      d.status AS draft_status,
      d.error AS draft_error

    FROM messages m

    LEFT JOIN drafts d
      ON d.message_id = m.id

    WHERE m.conversation_id = ?

    ORDER BY m.created_at, m.id
  `).all(id);

  return conversation;
}
