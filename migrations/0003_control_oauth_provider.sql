-- Better Auth OAuth provider tables. Date fields use Better Auth's millisecond timestamp format.
-- The OAuth provider's JWT access tokens require Better Auth's `jwt` plugin key store.
CREATE TABLE IF NOT EXISTS jwks (
    id TEXT PRIMARY KEY,
    publicKey TEXT NOT NULL,
    privateKey TEXT NOT NULL,
    createdAt INTEGER NOT NULL,
    expiresAt INTEGER
);

CREATE TABLE IF NOT EXISTS oauthClient (
    id TEXT PRIMARY KEY,
    clientId TEXT NOT NULL UNIQUE,
    clientSecret TEXT,
    disabled BOOLEAN,
    skipConsent BOOLEAN,
    enableEndSession BOOLEAN,
    subjectType TEXT,
    scopes TEXT,
    userId TEXT REFERENCES user(id) ON DELETE CASCADE,
    createdAt INTEGER,
    updatedAt INTEGER,
    name TEXT,
    uri TEXT,
    icon TEXT,
    contacts TEXT,
    tos TEXT,
    policy TEXT,
    softwareId TEXT,
    softwareVersion TEXT,
    softwareStatement TEXT,
    redirectUris TEXT NOT NULL,
    postLogoutRedirectUris TEXT,
    tokenEndpointAuthMethod TEXT,
    grantTypes TEXT,
    responseTypes TEXT,
    public BOOLEAN,
    type TEXT,
    requirePKCE BOOLEAN,
    referenceId TEXT,
    metadata TEXT
);

CREATE TABLE IF NOT EXISTS oauthRefreshToken (
    id TEXT PRIMARY KEY,
    token TEXT NOT NULL UNIQUE,
    clientId TEXT NOT NULL REFERENCES oauthClient(clientId) ON DELETE CASCADE,
    sessionId TEXT REFERENCES session(id) ON DELETE SET NULL,
    userId TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
    referenceId TEXT,
    expiresAt INTEGER NOT NULL,
    createdAt INTEGER NOT NULL,
    revoked INTEGER,
    authTime INTEGER,
    scopes TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS oauthAccessToken (
    id TEXT PRIMARY KEY,
    token TEXT UNIQUE,
    clientId TEXT NOT NULL REFERENCES oauthClient(clientId) ON DELETE CASCADE,
    sessionId TEXT REFERENCES session(id) ON DELETE SET NULL,
    userId TEXT REFERENCES user(id) ON DELETE CASCADE,
    referenceId TEXT,
    refreshId TEXT REFERENCES oauthRefreshToken(id) ON DELETE SET NULL,
    expiresAt INTEGER NOT NULL,
    createdAt INTEGER NOT NULL,
    scopes TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS oauthConsent (
    id TEXT PRIMARY KEY,
    clientId TEXT NOT NULL REFERENCES oauthClient(clientId) ON DELETE CASCADE,
    userId TEXT REFERENCES user(id) ON DELETE CASCADE,
    referenceId TEXT,
    scopes TEXT NOT NULL,
    createdAt INTEGER NOT NULL,
    updatedAt INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS oauthClient_userId_idx ON oauthClient(userId);
CREATE INDEX IF NOT EXISTS oauthRefreshToken_clientId_idx ON oauthRefreshToken(clientId);
CREATE INDEX IF NOT EXISTS oauthRefreshToken_sessionId_idx ON oauthRefreshToken(sessionId);
CREATE INDEX IF NOT EXISTS oauthRefreshToken_userId_idx ON oauthRefreshToken(userId);
CREATE INDEX IF NOT EXISTS oauthAccessToken_clientId_idx ON oauthAccessToken(clientId);
CREATE INDEX IF NOT EXISTS oauthAccessToken_sessionId_idx ON oauthAccessToken(sessionId);
CREATE INDEX IF NOT EXISTS oauthAccessToken_userId_idx ON oauthAccessToken(userId);
CREATE INDEX IF NOT EXISTS oauthAccessToken_refreshId_idx ON oauthAccessToken(refreshId);
CREATE INDEX IF NOT EXISTS oauthConsent_clientId_idx ON oauthConsent(clientId);
CREATE INDEX IF NOT EXISTS oauthConsent_userId_idx ON oauthConsent(userId);

CREATE TABLE IF NOT EXISTS controlOAuthTokenFamily (
    id TEXT PRIMARY KEY,
    userId TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
    clientId TEXT NOT NULL REFERENCES oauthClient(clientId) ON DELETE CASCADE,
    compromisedAt INTEGER,
    revokedAt INTEGER,
    createdAt INTEGER NOT NULL,
    updatedAt INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS controlOAuthTokenFamily_userId_idx ON controlOAuthTokenFamily(userId);
CREATE INDEX IF NOT EXISTS controlOAuthTokenFamily_clientId_idx ON controlOAuthTokenFamily(clientId);

-- Application bindings contain only SHA-256 token hashes; Better Auth retains its own hashed token records.
CREATE TABLE IF NOT EXISTS controlOAuthTokenBinding (
    id TEXT PRIMARY KEY,
    accessTokenHash TEXT NOT NULL UNIQUE,
    refreshTokenHash TEXT UNIQUE,
    familyId TEXT NOT NULL REFERENCES controlOAuthTokenFamily(id) ON DELETE CASCADE,
    userId TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
    clientId TEXT NOT NULL REFERENCES oauthClient(clientId) ON DELETE CASCADE,
    sessionId TEXT REFERENCES session(id) ON DELETE SET NULL,
    resource TEXT NOT NULL,
    scopes TEXT NOT NULL,
    issuer TEXT NOT NULL,
    expiresAt INTEGER NOT NULL,
    refreshExpiresAt INTEGER,
    refreshConsumedAt INTEGER,
    replacedById TEXT REFERENCES controlOAuthTokenBinding(id) ON DELETE SET NULL,
    revokedAt INTEGER,
    createdAt INTEGER NOT NULL,
    updatedAt INTEGER NOT NULL,
    CHECK (length(accessTokenHash) = 64),
    CHECK (refreshTokenHash IS NULL OR length(refreshTokenHash) = 64),
    CHECK (expiresAt > createdAt)
);

CREATE INDEX IF NOT EXISTS controlOAuthTokenBinding_familyId_idx ON controlOAuthTokenBinding(familyId);
CREATE INDEX IF NOT EXISTS controlOAuthTokenBinding_refreshTokenHash_idx ON controlOAuthTokenBinding(refreshTokenHash);
CREATE INDEX IF NOT EXISTS controlOAuthTokenBinding_replacedById_idx ON controlOAuthTokenBinding(replacedById);
CREATE INDEX IF NOT EXISTS controlOAuthTokenBinding_sessionId_idx ON controlOAuthTokenBinding(sessionId);
CREATE INDEX IF NOT EXISTS controlOAuthTokenBinding_active_idx ON controlOAuthTokenBinding(resource, revokedAt, expiresAt);

CREATE TABLE IF NOT EXISTS controlOAuthRegistrationRate (
    networkHash TEXT NOT NULL,
    windowStart INTEGER NOT NULL,
    count INTEGER NOT NULL CHECK (count > 0),
    PRIMARY KEY (networkHash, windowStart),
    CHECK (length(networkHash) = 64)
);
