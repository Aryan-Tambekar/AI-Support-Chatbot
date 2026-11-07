import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import jwt from 'jsonwebtoken';
import { draftReply } from './ai.js';
import { db, getConversation, getConversationDetail, listConversations } from './db.js';
import { audit } from './logger.js';

loadEnvironmentFile();

const app = express();
const now = () => new Date().toISOString();
const jwtSecret = process.env.JWT_SECRET;
const webhookSecret = process.env.WEBHOOK_SECRET;
const agentEmail = process.env.AGENT_EMAIL;
const agentPassword = process.env.AGENT_PASSWORD;

configureMiddleware();
configureRoutes();
serveClientApplication();
startServer();

function loadEnvironmentFile() {
  if (!fs.existsSync('.env')) return;
  for (const line of fs.readFileSync('.env', 'utf8').split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Z0-9_]+)=(.*)$/);
    if (match && process.env[match[1]] === undefined) {
      process.env[match[1]] = match[2].replace(/^['"]|['"]$/g, '');
    }
  }
}

function configureMiddleware() {
  app.use((req, res, next) => {
    const origin = req.headers.origin;
    const localDevelopmentOrigin = origin?.match(/^http:\/\/localhost:\d+$/);
    res.setHeader(
      'Access-Control-Allow-Origin',
      localDevelopmentOrigin ? origin : (process.env.CORS_ORIGIN || 'http://localhost:5173'),
    );
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Signature');
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
  });
  app.use('/webhook', express.raw({ type: 'application/json', limit: '100kb' }));
  app.use('/api', express.json({ limit: '100kb' }));
}

function requireAgent(req, res, next) {
  try {
    const token = req.headers.authorization?.replace('Bearer ', '');
    req.agent = jwt.verify(token, jwtSecret);
    next();
  } catch {
    res.status(401).json({ error: 'Authentication required' });
  }
}

function configureRoutes() {
  app.post('/webhook', handleWebhook);
  app.post('/api/auth/login', loginAgent);
  app.get('/api/conversations', requireAgent, (_req, res) => res.json(listConversations()));
  app.get('/api/conversations/:id', requireAgent, getAgentConversation);
  app.post('/api/drafts/:id/retry', requireAgent, retryDraft);
  app.post('/api/drafts/:id/approve', requireAgent, approveDraft);
  app.post('/api/customer/messages', sendCustomerMessage);
  app.get('/api/customer/:customerId/conversation', getCustomerConversation);
  app.get('/api/health', (_req, res) => res.json({ ok: true }));
}

async function handleWebhook(req, res) {
  if (!Buffer.isBuffer(req.body)) {
    return res.status(400).json({ error: 'Expected application/json request body' });
  }
  if (!hasValidSignature(req.body, req.headers['x-signature'])) {
    return res.status(401).json({ error: 'Invalid signature' });
  }
  let payload;
  try {
    payload = JSON.parse(req.body.toString('utf8'));
  } catch {
    return res.status(400).json({ error: 'Invalid JSON' });
  }
  if (!isValidWebhookPayload(payload)) {
    return res.status(422).json({ error: 'Invalid webhook payload' });
  }
  try {
    const result = await ingestCustomerMessage(payload);
    return res.status(result.duplicate ? 200 : 201).json(result);
  } catch (error) {
    audit('backend', 'webhook_error', { eventId: payload.event_id, error: error.message });
    return res.status(500).json({ error: 'Unable to process message' });
  }
}

function loginAgent(req, res) {
  const { email, password } = req.body || {};
  if (email !== agentEmail || password !== agentPassword) {
    return res.status(401).json({ error: 'Invalid email or password' });
  }
  audit('backend', 'agent_login', { email });
  const token = jwt.sign({ email, role: 'agent' }, jwtSecret, { expiresIn: '8h' });
  return res.json({ token });
}

function getAgentConversation(req, res) {
  const conversation = getConversationDetail(req.params.id);
  if (!conversation) return res.status(404).json({ error: 'Conversation not found' });
  return res.json(conversation);
}

async function retryDraft(req, res) {
  const draft = db.prepare(`SELECT d.*, m.text FROM drafts d JOIN messages m ON m.id = d.message_id WHERE d.id = ?`).get(req.params.id);
  if (!draft) return res.status(404).json({ error: 'Draft not found' });
  try {
    const text = await draftReply(draft.text);
    db.prepare('UPDATE drafts SET text = ?, status = ?, error = NULL, updated_at = ? WHERE id = ?').run(text, 'ready', now(), draft.id);
    return res.json({ text, status: 'ready' });
  } catch (error) {
    db.prepare('UPDATE drafts SET status = ?, error = ?, updated_at = ? WHERE id = ?').run('failed', error.message, now(), draft.id);
    return res.status(503).json({ error: error.message });
  }
}

function approveDraft(req, res) {
  const text = req.body?.text?.trim();
  if (!text || text.length > 4000) return res.status(422).json({ error: 'Reply must be 1-4000 characters' });
  const draft = db.prepare(`SELECT d.*, m.conversation_id FROM drafts d JOIN messages m ON m.id = d.message_id WHERE d.id = ?`).get(req.params.id);
  if (!draft) return res.status(404).json({ error: 'Draft not found' });
  if (draft.status === 'used') return res.status(409).json({ error: 'Draft already approved' });
  db.prepare('INSERT INTO messages(conversation_id, sender, text, created_at) VALUES(?, ?, ?, ?)').run(draft.conversation_id, 'agent', text, now());
  db.prepare('UPDATE drafts SET status = ?, updated_at = ? WHERE id = ?').run('used', now(), draft.id);
  db.prepare('UPDATE conversations SET updated_at = ? WHERE id = ?').run(now(), draft.conversation_id);
  audit('backend', 'draft_approved', { draftId: draft.id });
  return res.status(201).json({ ok: true });
}

async function sendCustomerMessage(req, res) {
  const { customer, text } = req.body || {};
  if (!customer?.name?.trim() || !customer?.phone?.trim() || !text?.trim() || text.length > 4000) {
    return res.status(422).json({ error: 'Name, phone, and a message up to 4000 characters are required' });
  }
  const customerId = customerIdFromPhone(customer.phone);
  const payload = {
    event_id: crypto.randomUUID(),
    type: 'message.received',
    brand_id: 'verdant-co',
    timestamp: now(),
    customer: { id: customerId, name: customer.name.trim(), phone: customer.phone.trim() },
    message: { id: crypto.randomUUID(), type: 'text', text: text.trim() },
  };
  try {
    const result = await ingestCustomerMessage(payload);
    return res.status(201).json(result);
  } catch (error) {
    console.error('Customer message error:', error);
    return res.status(500).json({ error: 'Unable to send message' });
  }
}

function getCustomerConversation(req, res) {
  const conversation = getConversation(req.params.customerId);
  if (!conversation) return res.json({ messages: [] });
  const detail = getConversationDetail(conversation.conversation_id);
  const messages = detail.messages.filter((message) => message.sender === 'customer' || message.sender === 'agent').map(({ draft_text, draft_status, draft_error, ...message }) => message);
  return res.json({ ...detail, messages });
}

export function ingestCustomerMessage(payload) {
  const messageTime = isValidDate(payload.timestamp) ? payload.timestamp : now();
  const { customer, message } = payload;
  let conversationId;
  let messageId;
  try {
    db.exec('BEGIN IMMEDIATE');
    db.prepare('INSERT INTO webhook_events(event_id, received_at) VALUES(?, ?)').run(payload.event_id, now());
    db.prepare('INSERT OR IGNORE INTO customers(id, name, phone, created_at) VALUES(?, ?, ?, ?)').run(customer.id, customer.name.trim(), customer.phone.trim(), messageTime);
    let conversation = getConversation(customer.id);
    if (!conversation) {
      db.prepare('INSERT INTO conversations(customer_id, created_at, updated_at) VALUES(?, ?, ?)').run(customer.id, messageTime, messageTime);
      conversation = getConversation(customer.id);
    }
    const inserted = db.prepare('INSERT INTO messages(external_id, conversation_id, sender, text, created_at) VALUES(?, ?, ?, ?, ?)').run(message.id, conversation.conversation_id, 'customer', message.text.trim(), messageTime);
    messageId = Number(inserted.lastInsertRowid);
    conversationId = conversation.conversation_id;
    db.prepare('UPDATE conversations SET updated_at = ? WHERE id = ?').run(messageTime, conversationId);
    db.prepare('INSERT INTO drafts(message_id, status, created_at, updated_at) VALUES(?, ?, ?, ?)').run(messageId, 'pending', now(), now());
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    if (isConstraintError(error)) return { duplicate: true };
    throw error;
  }
  audit('backend', 'customer_message_saved', { eventId: payload.event_id, conversationId });
  createDraft(messageId, message.text, payload.event_id).catch((error) => audit('ai', 'draft_failed', { eventId: payload.event_id, error: error.message }));
  return { duplicate: false, conversationId, customerId: customer.id };
}

function isConstraintError(error) {
  return error?.code === 'ERR_SQLITE_CONSTRAINT' || error?.code?.startsWith('ERR_SQLITE_CONSTRAINT_') || String(error?.message || '').includes('UNIQUE constraint failed');
}

async function createDraft(messageId, messageText, eventId) {
  try {
    const text = await draftReply(messageText);
    db.prepare('UPDATE drafts SET text = ?, status = ?, updated_at = ? WHERE message_id = ?').run(text, 'ready', now(), messageId);
  } catch (error) {
    db.prepare('UPDATE drafts SET status = ?, error = ?, updated_at = ? WHERE message_id = ?').run('failed', error.message, now(), messageId);
    audit('ai', 'draft_failed', { eventId, error: error.message });
  }
}

function hasValidSignature(rawBody, signature) {
  const expected = `sha256=${crypto.createHmac('sha256', webhookSecret).update(rawBody).digest('hex')}`;
  return Boolean(signature) && signature.length === expected.length && crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
}

function isValidWebhookPayload(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return false;
  const isNonEmptyString = (value, maxLength = 255) =>
    typeof value === 'string' && value.trim().length > 0 && value.length <= maxLength;
  return (
    payload.type === 'message.received' &&
    payload.brand_id === 'verdant-co' &&
    isNonEmptyString(payload.event_id) &&
    isValidDate(payload.timestamp) &&
    isNonEmptyString(payload.customer?.id) &&
    isNonEmptyString(payload.customer?.name) &&
    isNonEmptyString(payload.customer?.phone, 30) &&
    isNonEmptyString(payload.message?.id) &&
    payload.message?.type === 'text' &&
    isNonEmptyString(payload.message?.text, 4000)
  );
}

function customerIdFromPhone(phone) {
  const hash = crypto.createHash('sha256').update(phone.trim()).digest('hex');
  return `web_${hash.slice(0, 16)}`;
}

function isValidDate(value) { return Boolean(value) && !Number.isNaN(Date.parse(value)); }

function serveClientApplication() {
  const clientDist = path.resolve('dist');
  if (!fs.existsSync(clientDist)) return;
  app.use(express.static(clientDist));
  app.get('*', (_req, res) => res.sendFile(path.join(clientDist, 'index.html')));
}

function startServer() {
  if (process.env.NODE_ENV === 'test') return;

  const port = process.env.PORT || 3001;

  app.listen(port, '0.0.0.0', () => {
    audit('backend', 'server_started', {
      port,
      environment: process.env.NODE_ENV
    });
  });
}

function recoverPendingDrafts() {
  const pending = db.prepare(`SELECT d.message_id, m.text FROM drafts d JOIN messages m ON m.id = d.message_id WHERE d.status = 'pending'`).all();
  for (const draft of pending) {
    audit('backend', 'draft_recovery_started', { messageId: draft.message_id });
    createDraft(draft.message_id, draft.text, null).catch((error) => audit('ai', 'draft_failed', { messageId: draft.message_id, error: error.message }));
  }
}

export { app };
