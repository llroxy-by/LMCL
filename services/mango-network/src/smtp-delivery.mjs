import net from 'node:net';
import tls from 'node:tls';
import { randomBytes } from 'node:crypto';
import { assertSafeHeader, createVerificationMail } from './mail-template.mjs';

const MODES = new Set(['starttls', 'smtps']);
const MAILBOX = /^[^\s<>@,;:\\"\[\]\r\n]+@[^\s<>@,;:\\"\[\]\r\n]+$/;

function mailbox(value, field) {
  assertSafeHeader(value, field);
  if (!MAILBOX.test(value)) throw new TypeError(`${field} must be a simple email address`);
  return value;
}

function singleLine(value, field) {
  return assertSafeHeader(value, field);
}

function encodeHeader(value) {
  singleLine(value, 'subject');
  return /^[\x20-\x7e]*$/.test(value)
    ? value
    : `=?UTF-8?B?${Buffer.from(value).toString('base64')}?=`;
}

function normalizeBody(value) {
  return String(value).replace(/\r?\n/g, '\r\n').replace(/\r(?!\n)/g, '\r\n');
}

export function composeMessage({ from, to, subject, text, html }) {
  from = mailbox(from, 'from');
  to = mailbox(to, 'to');
  if (typeof text !== 'string' || typeof html !== 'string') throw new TypeError('text and html bodies are required');
  const boundary = `mango-${randomBytes(12).toString('hex')}`;
  return [
    `From: <${from}>`,
    `To: <${to}>`,
    `Subject: ${encodeHeader(subject)}`,
    'MIME-Version: 1.0',
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    '',
    `--${boundary}`,
    'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: 8bit',
    '',
    normalizeBody(text),
    `--${boundary}`,
    'Content-Type: text/html; charset=utf-8',
    'Content-Transfer-Encoding: 8bit',
    '',
    normalizeBody(html),
    `--${boundary}--`,
    ''
  ].join('\r\n');
}

class ReplyReader {
  constructor(socket, timeoutMs) {
    this.socket = socket;
    this.timeoutMs = timeoutMs;
    this.buffer = '';
    this.lines = [];
    this.waiter = null;
    this.error = null;
    this.onData = (chunk) => {
      this.buffer += chunk.toString('utf8');
      let end;
      while ((end = this.buffer.indexOf('\n')) !== -1) {
        this.lines.push(this.buffer.slice(0, end + 1).replace(/\r?\n$/, ''));
        this.buffer = this.buffer.slice(end + 1);
      }
      this.#flush();
    };
    this.onError = (error) => { this.error = error; this.#flush(); };
    this.onClose = () => { this.error ??= new Error('SMTP connection closed'); this.#flush(); };
    socket.on('data', this.onData);
    socket.on('error', this.onError);
    socket.on('close', this.onClose);
  }

  detach() {
    this.socket.off('data', this.onData);
    this.socket.off('error', this.onError);
    this.socket.off('close', this.onClose);
  }

  #flush() {
    if (!this.waiter) return;
    if (this.error) {
      const { reject, timer } = this.waiter;
      this.waiter = null;
      clearTimeout(timer);
      reject(this.error);
      return;
    }
    if (!this.lines.length) return;
    const first = this.lines[0];
    const match = /^(\d{3})([ -])/.exec(first);
    if (!match) return this.#fail(new Error(`Malformed SMTP reply: ${first}`));
    const code = Number(match[1]);
    let count = 1;
    if (match[2] === '-') {
      while (count < this.lines.length && !this.lines[count].startsWith(`${code} `)) count++;
      if (count === this.lines.length) return;
      count++;
    }
    const response = this.lines.splice(0, count).join('\n');
    const { resolve, timer } = this.waiter;
    this.waiter = null;
    clearTimeout(timer);
    resolve({ code, text: response });
  }

  #fail(error) {
    this.error = error;
    this.#flush();
  }

  read() {
    if (this.waiter) return Promise.reject(new Error('Concurrent SMTP reply reads are not supported'));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.waiter) this.waiter = null;
        reject(new Error('SMTP command timed out'));
        this.socket.destroy();
      }, this.timeoutMs);
      this.waiter = { resolve, reject, timer };
      this.#flush();
    });
  }
}

function expect(reply, codes, operation) {
  if (!codes.includes(reply.code)) throw new Error(`SMTP ${operation} failed with status ${reply.code}`);
  return reply;
}

function write(socket, value) {
  return new Promise((resolve, reject) => socket.write(value, (error) => error ? reject(error) : resolve()));
}

async function command(socket, reader, value, codes) {
  await write(socket, `${value}\r\n`);
  return expect(await reader.read(), codes, value.split(' ', 1)[0]);
}

function dotStuff(message) {
  return normalizeBody(message).replace(/^\./gm, '..');
}

const defaultFactories = {
  plain: ({ host, port }) => net.connect({ host, port }),
  secure: ({ host, port, servername, socket }) => tls.connect({ host: socket ? undefined : host, port: socket ? undefined : port, servername, socket })
};

export class SmtpDelivery {
  constructor({ host, port, mode, from, auth, timeoutMs = 10_000, clientName = 'localhost', factories = defaultFactories }) {
    if (typeof host !== 'string' || !host) throw new TypeError('host is required');
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new TypeError('port is invalid');
    if (!MODES.has(mode)) throw new TypeError('mode must be starttls or smtps');
    this.config = { host, port, mode, from: mailbox(from, 'from'), timeoutMs, clientName: singleLine(clientName, 'clientName') };
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1) throw new TypeError('timeoutMs must be a positive integer');
    if (auth !== undefined) {
      if (!auth || typeof auth.username !== 'string' || !auth.username || typeof auth.password !== 'string' || !auth.password) {
        throw new TypeError('auth must contain explicit username and password');
      }
      if (/[\r\n\0]/.test(auth.username) || /[\r\n\0]/.test(auth.password)) throw new TypeError('auth contains invalid characters');
    }
    this.auth = auth;
    if (!factories || typeof factories.plain !== 'function' || typeof factories.secure !== 'function') throw new TypeError('socket factories are required');
    this.factories = factories;
  }

  async send({ to, subject, text, html }) {
    to = mailbox(to, 'to');
    const message = composeMessage({ from: this.config.from, to, subject, text, html });
    let socket;
    let reader;
    try {
      socket = this.config.mode === 'smtps'
        ? this.factories.secure({ host: this.config.host, port: this.config.port, servername: this.config.host })
        : this.factories.plain({ host: this.config.host, port: this.config.port });
      socket.setTimeout?.(this.config.timeoutMs, () => socket.destroy(new Error('SMTP socket timed out')));
      reader = new ReplyReader(socket, this.config.timeoutMs);
      expect(await reader.read(), [220], 'greeting');
      let ehlo = await command(socket, reader, `EHLO ${this.config.clientName}`, [250]);

      if (this.config.mode === 'starttls') {
        if (!/(^|\n)250[ -]STARTTLS(?:\s|$)/i.test(ehlo.text)) throw new Error('SMTP server does not advertise STARTTLS');
        await command(socket, reader, 'STARTTLS', [220]);
        reader.detach();
        socket = this.factories.secure({ host: this.config.host, port: this.config.port, servername: this.config.host, socket });
        socket.setTimeout?.(this.config.timeoutMs, () => socket.destroy(new Error('SMTP socket timed out')));
        reader = new ReplyReader(socket, this.config.timeoutMs);
        ehlo = await command(socket, reader, `EHLO ${this.config.clientName}`, [250]);
      }

      if (this.auth) {
        await command(socket, reader, 'AUTH LOGIN', [334]);
        await command(socket, reader, Buffer.from(this.auth.username).toString('base64'), [334]);
        await command(socket, reader, Buffer.from(this.auth.password).toString('base64'), [235]);
      }

      await command(socket, reader, `MAIL FROM:<${this.config.from}>`, [250]);
      await command(socket, reader, `RCPT TO:<${to}>`, [250, 251]);
      await command(socket, reader, 'DATA', [354]);
      await write(socket, `${dotStuff(message)}\r\n.\r\n`);
      expect(await reader.read(), [250], 'message delivery');
      await command(socket, reader, 'QUIT', [221]);
      return { accepted: true };
    } finally {
      reader?.detach();
      socket?.destroy();
    }
  }
}

export function createVerificationDelivery({ productName = 'Mango Network', ...smtpConfig }) {
  const smtp = new SmtpDelivery(smtpConfig);
  return async ({ to, code, expiresAt }) => {
    const template = createVerificationMail({ code, expiresAt, productName });
    return smtp.send({ to, ...template });
  };
}
