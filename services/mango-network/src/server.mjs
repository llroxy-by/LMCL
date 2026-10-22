import { loadConfig } from './config.mjs';
import { MangoService } from './mango-service.mjs';
import { createHttpServer } from './http-server.mjs';
import { createVerificationDelivery } from './smtp-delivery.mjs';
import { MemoryUserRepository, MemorySessionRepository, MemoryCloudSaveRepository } from './repositories.mjs';

const config = loadConfig({
  HOST: process.env.MANGO_HOST || '127.0.0.1',
  PORT: process.env.MANGO_PORT || '8795',
  TOKEN_PEPPER: process.env.MANGO_TOKEN_PEPPER || 'a'.repeat(32),
  VERIFICATION_TTL_MS: process.env.MANGO_VERIFY_TTL || '600000',
  ACCESS_TTL_MS: process.env.MANGO_ACCESS_TTL || '900000',
  REFRESH_TTL_MS: process.env.MANGO_REFRESH_TTL || '2592000000'
});

let verificationDelivery = async ({ to, code }) => {
  console.log(`[DEV/TEST] Verification code for ${to}: ${code}`);
};

if (process.env.SMTP_HOST && process.env.SMTP_USERNAME) {
  verificationDelivery = createVerificationDelivery({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 465),
    mode: process.env.SMTP_PORT === '587' ? 'starttls' : 'smtps',
    user: process.env.SMTP_USERNAME,
    pass: process.env.SMTP_PASSWORD,
    from: process.env.MAIL_FROM_ADDRESS || process.env.SMTP_USERNAME,
    productName: process.env.MAIL_FROM_NAME || 'Mango Network'
  });
}

const service = new MangoService({
  config,
  users: new MemoryUserRepository(),
  sessions: new MemorySessionRepository(),
  saves: new MemoryCloudSaveRepository(),
  verificationDelivery
});

const server = createHttpServer({ service, config });

server.listen(config.port, config.host, () => {
  console.log(`Mango Network service successfully listening on ${config.host}:${config.port}`);
});
