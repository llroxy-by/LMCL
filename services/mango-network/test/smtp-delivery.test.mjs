import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { createVerificationMail } from '../src/mail-template.mjs';
import { composeMessage, createVerificationDelivery, SmtpDelivery } from '../src/smtp-delivery.mjs';

class FakeSocket extends EventEmitter {
  constructor({ starttls = false, silent = false } = {}) {
    super();
    this.starttls = starttls;
    this.silent = silent;
    this.commands = [];
    this.inData = false;
    this.message = '';
    if (!silent) queueMicrotask(() => this.emit('data', Buffer.from('220 fake.example ESMTP\r\n')));
  }

  setTimeout() {}
  destroy(error) {
    if (this.destroyed) return;
    this.destroyed = true;
    if (error) queueMicrotask(() => this.emit('error', error));
    queueMicrotask(() => this.emit('close'));
  }

  write(value, callback) {
    const input = String(value);
    if (this.inData) {
      this.message += input.replace(/\r\n\.\r\n$/, '');
      this.inData = false;
      queueMicrotask(() => this.emit('data', Buffer.from('250 queued\r\n')));
      callback?.();
      return true;
    }

    const command = input.replace(/\r\n$/, '');
    this.commands.push(command);
    let response;
    if (command.startsWith('EHLO ')) response = this.starttls ? '250-fake.example\r\n250-STARTTLS\r\n250 AUTH LOGIN\r\n' : '250-fake.example\r\n250 AUTH LOGIN\r\n';
    else if (command === 'STARTTLS') { response = '220 ready\r\n'; this.starttls = false; }
    else if (command === 'AUTH LOGIN') response = '334 VXNlcm5hbWU6\r\n';
    else if (command === Buffer.from('mailer').toString('base64')) response = '334 UGFzc3dvcmQ6\r\n';
    else if (command === Buffer.from('secret').toString('base64')) response = '235 authenticated\r\n';
    else if (command.startsWith('MAIL FROM:') || command.startsWith('RCPT TO:')) response = '250 ok\r\n';
    else if (command === 'DATA') { response = '354 continue\r\n'; this.inData = true; }
    else if (command === 'QUIT') response = '221 bye\r\n';
    else response = '500 unexpected\r\n';
    queueMicrotask(() => this.emit('data', Buffer.from(response)));
    callback?.();
    return true;
  }
}

function fakeFactories(socket, calls) {
  return {
    plain(options) { calls.push(['plain', options]); return socket; },
    secure(options) { calls.push(['secure', options]); return socket; }
  };
}

test('verification template contains escaped HTML and a plain-text alternative', () => {
  const mail = createVerificationMail({ code: '<123&456>', expiresAt: 1_700_000_000_000, productName: 'Mango Network' });
  assert.match(mail.text, /<123&456>/);
  assert.match(mail.html, /&lt;123&amp;456&gt;/);
  assert.match(mail.text, /2023-11-14T22:13:20.000Z/);
  assert.match(mail.subject, /email verification/);
});

test('message composition rejects address and subject header injection', () => {
  const valid = { from: 'no-reply@example.test', to: 'player@example.test', subject: 'Verify', text: 'text', html: '<p>text</p>' };
  assert.throws(() => composeMessage({ ...valid, to: 'player@example.test\r\nBcc: thief@example.test' }), /single-line/);
  assert.throws(() => composeMessage({ ...valid, from: 'sender@example.test\nX-Evil: yes' }), /single-line/);
  assert.throws(() => composeMessage({ ...valid, subject: 'Verify\r\nBcc: thief@example.test' }), /single-line/);
  assert.match(composeMessage(valid), /multipart\/alternative/);
});

test('STARTTLS session upgrades, authenticates with LOGIN, and delivers without logging the code', async () => {
  const socket = new FakeSocket({ starttls: true });
  const calls = [];
  const logs = [];
  const originalLog = console.log;
  console.log = (...args) => logs.push(args.join(' '));
  try {
    const deliver = createVerificationDelivery({
      host: 'smtp.example.test', port: 587, mode: 'starttls', from: 'no-reply@example.test',
      auth: { username: 'mailer', password: 'secret' }, timeoutMs: 100, factories: fakeFactories(socket, calls)
    });
    assert.deepEqual(await deliver({ to: 'player@example.test', code: '839201', expiresAt: 1_700_000_000_000 }), { accepted: true });
  } finally {
    console.log = originalLog;
  }

  assert.deepEqual(calls.map(([kind]) => kind), ['plain', 'secure']);
  assert.equal(calls[1][1].socket, socket);
  assert.deepEqual(socket.commands.slice(0, 6), [
    'EHLO localhost', 'STARTTLS', 'EHLO localhost', 'AUTH LOGIN',
    Buffer.from('mailer').toString('base64'), Buffer.from('secret').toString('base64')
  ]);
  assert.match(socket.message, /839201/);
  assert.match(socket.message, /Content-Type: text\/plain/);
  assert.match(socket.message, /Content-Type: text\/html/);
  assert.ok(logs.every((line) => !line.includes('839201')));
});

test('SMTPS starts with a secure transport and needs no STARTTLS command', async () => {
  const socket = new FakeSocket();
  const calls = [];
  const smtp = new SmtpDelivery({
    host: 'smtp.example.test', port: 465, mode: 'smtps', from: 'no-reply@example.test',
    timeoutMs: 100, factories: fakeFactories(socket, calls)
  });
  await smtp.send({ to: 'player@example.test', subject: 'Hello', text: 'plain', html: '<p>html</p>' });
  assert.deepEqual(calls.map(([kind]) => kind), ['secure']);
  assert.ok(!socket.commands.includes('STARTTLS'));
});

test('SMTP greeting timeout rejects and does not access ambient configuration', async () => {
  const socket = new FakeSocket({ silent: true });
  const smtp = new SmtpDelivery({
    host: 'explicit.example.test', port: 465, mode: 'smtps', from: 'no-reply@example.test',
    timeoutMs: 10, factories: fakeFactories(socket, [])
  });
  await assert.rejects(
    smtp.send({ to: 'player@example.test', subject: 'Hello', text: 'plain', html: '<p>html</p>' }),
    /timed out/
  );
});
