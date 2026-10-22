const IDENTIFIER = /^[a-z_][a-z0-9_]{0,62}$/;

function quoteIdentifier(value) {
  if (!IDENTIFIER.test(value)) throw new TypeError('schema must be a lowercase PostgreSQL identifier');
  return `"${value}"`;
}

export const POSTGRES_MIGRATIONS = Object.freeze([
  Object.freeze({
    version: 1,
    name: 'identity_sessions_and_cloud_saves',
    statements: Object.freeze([
      `CREATE TABLE users (
  id uuid PRIMARY KEY,
  email text NOT NULL,
  status text NOT NULL CHECK (status IN ('pending_email_verification', 'active', 'disabled')),
  password_hash text NOT NULL CHECK (length(password_hash) >= 32),
  verification_code_hash text,
  verification_expires_at timestamptz,
  verification_attempts integer NOT NULL DEFAULT 0 CHECK (verification_attempts >= 0 AND verification_attempts <= 10),
  created_at timestamptz NOT NULL,
  verified_at timestamptz,
  CONSTRAINT users_email_normalized CHECK (email = lower(btrim(email)) AND length(email) <= 254),
  CONSTRAINT users_verification_state CHECK (
    (status = 'pending_email_verification' AND verification_code_hash IS NOT NULL AND verification_expires_at IS NOT NULL)
    OR (status <> 'pending_email_verification' AND verification_code_hash IS NULL AND verification_expires_at IS NULL)
  )
)`,
      'CREATE UNIQUE INDEX users_email_uq ON users (email)',
      `CREATE TABLE sessions (
  id uuid PRIMARY KEY,
  family_id uuid NOT NULL,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  access_hash text NOT NULL CHECK (length(access_hash) >= 32),
  refresh_hash text NOT NULL CHECK (length(refresh_hash) >= 32),
  access_expires_at timestamptz NOT NULL,
  refresh_expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL,
  revoked_at timestamptz,
  revoke_reason text,
  rotated_to uuid REFERENCES sessions(id) ON DELETE SET NULL,
  CONSTRAINT sessions_expiry_order CHECK (access_expires_at <= refresh_expires_at),
  CONSTRAINT sessions_revocation_pair CHECK ((revoked_at IS NULL) = (revoke_reason IS NULL))
)`,
      'CREATE INDEX sessions_user_id_idx ON sessions (user_id)',
      'CREATE INDEX sessions_family_id_idx ON sessions (family_id)',
      'CREATE INDEX sessions_refresh_expiry_idx ON sessions (refresh_expires_at) WHERE revoked_at IS NULL',
      `CREATE TABLE cloud_saves (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  id varchar(128) NOT NULL,
  name varchar(128) NOT NULL CHECK (length(btrim(name)) > 0),
  current_version bigint NOT NULL CHECK (current_version > 0),
  size_bytes bigint NOT NULL CHECK (size_bytes >= 0),
  checksum_sha256 char(64) NOT NULL CHECK (checksum_sha256 ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (user_id, id),
  CONSTRAINT cloud_saves_id_format CHECK (id ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$'),
  CONSTRAINT cloud_saves_time_order CHECK (updated_at >= created_at)
)`,
      `CREATE TABLE cloud_save_snapshots (
  user_id uuid NOT NULL,
  save_id varchar(128) NOT NULL,
  version bigint NOT NULL CHECK (version > 0),
  object_key varchar(512) NOT NULL UNIQUE,
  size_bytes bigint NOT NULL CHECK (size_bytes >= 0),
  checksum_sha256 char(64) NOT NULL CHECK (checksum_sha256 ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL,
  PRIMARY KEY (user_id, save_id, version),
  FOREIGN KEY (user_id, save_id) REFERENCES cloud_saves(user_id, id) ON DELETE CASCADE
)`,
      'CREATE INDEX cloud_save_snapshots_created_idx ON cloud_save_snapshots (created_at)'
    ])
  }),
  Object.freeze({
    version: 2,
    name: 'storage_object_lifecycle',
    statements: Object.freeze([
      `CREATE TABLE storage_objects (
  object_key varchar(512) PRIMARY KEY,
  owner_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  content_type varchar(255) NOT NULL,
  size_bytes bigint NOT NULL CHECK (size_bytes >= 0),
  checksum_sha256 char(64) NOT NULL CHECK (checksum_sha256 ~ '^[0-9a-f]{64}$'),
  storage_version varchar(128) NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  deleted_at timestamptz,
  CONSTRAINT storage_objects_key_format CHECK (object_key ~ '^[A-Za-z0-9][A-Za-z0-9._/-]{0,511}$'),
  CONSTRAINT storage_objects_time_order CHECK (updated_at >= created_at AND (deleted_at IS NULL OR deleted_at >= created_at))
)`,
      'CREATE INDEX storage_objects_owner_idx ON storage_objects (owner_user_id, updated_at DESC)',
      'CREATE INDEX storage_objects_live_idx ON storage_objects (object_key) WHERE deleted_at IS NULL'
    ])
  })
]);

export function describePostgresMigrations() {
  return POSTGRES_MIGRATIONS.map(({ version, name, statements }) => ({ version, name, statements: [...statements] }));
}

export function generatePostgresDDL({ schema = 'public', fromVersion = 0, toVersion = Infinity } = {}) {
  if (!Number.isInteger(fromVersion) || fromVersion < 0) throw new TypeError('fromVersion must be a non-negative integer');
  if (!(toVersion === Infinity || (Number.isInteger(toVersion) && toVersion >= fromVersion))) {
    throw new TypeError('toVersion must be an integer greater than or equal to fromVersion');
  }
  const selected = POSTGRES_MIGRATIONS.filter(({ version }) => version > fromVersion && version <= toVersion);
  const namespace = quoteIdentifier(schema);
  const parts = [
    'BEGIN;',
    `CREATE SCHEMA IF NOT EXISTS ${namespace};`,
    `SET LOCAL search_path TO ${namespace}, pg_catalog;`,
    `CREATE TABLE IF NOT EXISTS schema_migrations (\n  version integer PRIMARY KEY CHECK (version > 0),\n  name text NOT NULL,\n  applied_at timestamptz NOT NULL DEFAULT now()\n);`
  ];
  for (const migration of selected) {
    const escapedName = migration.name.replaceAll("'", "''");
    parts.push(`-- migration ${migration.version}: ${migration.name}`);
    parts.push(...migration.statements.map((statement) => `${statement};`));
    parts.push(`INSERT INTO schema_migrations (version, name) VALUES (${migration.version}, '${escapedName}');`);
  }
  parts.push('COMMIT;');
  return `${parts.join('\n\n')}\n`;
}
