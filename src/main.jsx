import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './styles.css';

const SAMPLE_MESSAGES = [
  'Hi, my order #4471 hasn’t arrived yet. Can I change the delivery address?',
  'What is your return policy?',
  'Do you deliver to Dubai?',
  'Is cash on delivery available for a ₹3,500 order?',
  'I think I’m allergic to the serum I bought. What should I do?',
];

const apiBaseUrl = import.meta.env.DEV
  ? (import.meta.env.VITE_API_URL || 'http://localhost:3001')
  : '';

async function request(path, { token, ...options } = {}) {
  const response = await fetch(`${apiBaseUrl}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
  });
  const responseText = await response.text();
  let data;

  try {
    data = JSON.parse(responseText);
  } catch {
    throw new Error(
      'The API returned an HTML page instead of JSON. Restart the app with "npm run dev" and open the URL shown by Vite.',
    );
  }

  if (!response.ok) throw new Error(data.error || 'Request failed');
  return data;
}

function CustomerView() {
  const [customer, setCustomer] = useState({ id: localStorage.customerId || '', name: 'Aisha Khan', phone: '+919800000001' });
  const [text, setText] = useState(SAMPLE_MESSAGES[0]);
  const [messages, setMessages] = useState([]);
  const [notice, setNotice] = useState('');

  async function loadConversation(id = customer.id) {
    if (!id) return;
    try {
      const conversation = await request(`/api/customer/${id}/conversation`);
      setMessages(conversation.messages || []);
    } catch {
      // A customer may not have a conversation yet.
    }
  }

  useEffect(() => { loadConversation(); }, [customer.id]);

  async function sendMessage() {
    try {
      setNotice('Sending…');
      const result = await request('/api/customer/messages', {
        method: 'POST',
        body: JSON.stringify({ customer, text }),
      });
      localStorage.customerId = result.customerId;
      setCustomer({ ...customer, id: result.customerId });
      setText('');
      setNotice('Message received.');
      loadConversation(result.customerId);
    } catch (error) {
      setNotice(error.message);
    }
  }

  return <main>
    <section className="card">
      <h2>Customer test view</h2>
      <div className="row">
        <input value={customer.name} placeholder="Name" onChange={(event) => setCustomer({ ...customer, name: event.target.value })} />
        <input value={customer.phone} placeholder="Phone" onChange={(event) => setCustomer({ ...customer, phone: event.target.value })} />
      </div>
      <select value={text} onChange={(event) => setText(event.target.value)}>
        {SAMPLE_MESSAGES.map((sample) => <option key={sample}>{sample}</option>)}
      </select>
      <textarea value={text} placeholder="Type a message" onChange={(event) => setText(event.target.value)} />
      <button onClick={sendMessage}>Send message</button>
      {notice && <p className="notice">{notice}</p>}
    </section>
    <Conversation messages={messages} />
  </main>;
}

function Conversation({ messages }) {
  return <section className="card">
    <h2>Conversation</h2>
    {messages.length === 0 ? <p className="muted">No messages yet.</p> : <div className="thread">
      {messages.map((message) => <article className={`bubble ${message.sender}`} key={message.id}>
        <small>{message.sender === 'customer' ? 'Customer' : 'Verdant & Co'} · {new Date(message.created_at).toLocaleString()}</small>
        <div>{message.text}</div>
      </article>)}
    </div>}
  </section>;
}

function AgentView() {
  const [token, setToken] = useState(localStorage.token || '');
  const [email, setEmail] = useState('agent@verdant.co');
  const [password, setPassword] = useState('verdant-demo');
  const [conversations, setConversations] = useState([]);
  const [selectedId, setSelectedId] = useState(null);
  const [selected, setSelected] = useState(null);
  const [error, setError] = useState('');

  async function loadInbox() {
    try { setConversations(await request('/api/conversations', { token })); } catch (err) { setError(err.message); }
  }
  useEffect(() => { if (token) loadInbox(); }, [token]);

  async function openConversation(id) {
    try {
      setSelected(await request(`/api/conversations/${id}`, { token }));
      setSelectedId(id);
    } catch (err) { setError(err.message); }
  }

  async function signIn() {
    try {
      const result = await request('/api/auth/login', { method: 'POST', body: JSON.stringify({ email, password }) });
      localStorage.token = result.token;
      setToken(result.token);
    } catch (err) { setError(err.message); }
  }

  async function approveDraft(draftId, text) {
    try {
      await request(`/api/drafts/${draftId}/approve`, { method: 'POST', token, body: JSON.stringify({ text }) });
      await openConversation(selectedId);
      loadInbox();
    } catch (err) { setError(err.message); }
  }

  if (!token) return <main><section className="card login">
    <h2>Agent sign in</h2><p className="muted">Demo: agent@verdant.co / verdant-demo</p>
    <input value={email} placeholder="Email" onChange={(event) => setEmail(event.target.value)} />
    <input value={password} type="password" placeholder="Password" onChange={(event) => setPassword(event.target.value)} />
    <button onClick={signIn}>Sign in</button>{error && <p className="error">{error}</p>}
  </section></main>;

  return <main className="agent">
    <aside className="card"><div className="inboxhead"><h2>Inbox</h2><button className="link" onClick={() => { localStorage.removeItem('token'); setToken(''); }}>Sign out</button></div>
      {conversations.map((conversation) => <button className={`conversation ${selectedId === conversation.id ? 'active' : ''}`} key={conversation.id} onClick={() => openConversation(conversation.id)}>
        <strong>{conversation.name}</strong><span>{conversation.latest_text || 'No messages'}</span><small>{new Date(conversation.updated_at).toLocaleString()}</small>
      </button>)}
    </aside>
    <section className="card">{selected ? <><h2>{selected.name}</h2><div className="thread">
      {selected.messages.map((message) => <React.Fragment key={message.id}>
        <article className={`bubble ${message.sender}`}><small>{message.sender === 'customer' ? 'Customer' : 'Agent'} · {new Date(message.created_at).toLocaleString()}</small><div>{message.text}</div></article>
        {message.draft_id && message.draft_status === 'ready' && <DraftEditor draft={message} onApprove={approveDraft} />}
        {message.draft_id && message.draft_status === 'failed' && <div className="error">Draft unavailable: {message.draft_error}</div>}
      </React.Fragment>)}
    </div></> : <p className="muted">Select a conversation.</p>}{error && <p className="error">{error}</p>}</section>
  </main>;
}

function DraftEditor({ draft, onApprove }) {
  const [text, setText] = useState(draft.draft_text);
  return <div className="draft"><label>AI suggested reply (review before sending)</label>
    <textarea value={text} onChange={(event) => setText(event.target.value)} />
    <button onClick={() => onApprove(draft.draft_id, text)}>Approve reply</button>
  </div>;
}

function App() {
  const [mode, setMode] = useState('customer');
  return <><header><div><b>Verdant & Co</b><span>Support Console</span></div><div className="toggle">
    <button className={mode === 'customer' ? 'chosen' : ''} onClick={() => setMode('customer')}>Customer</button>
    <button className={mode === 'agent' ? 'chosen' : ''} onClick={() => setMode('agent')}>Agent</button>
  </div></header>{mode === 'customer' ? <CustomerView /> : <AgentView />}</>;
}

createRoot(document.getElementById('root')).render(<App />);
