-- Better Auth 1.7 OAuth provider schema additions (resources, DPoP, client assertions, rotation replay).
-- Generated from the installed plugin options with better-auth's getMigrations against 0001-0003.
-- Date fields use Better Auth's millisecond timestamp format, so they are INTEGER as in 0003.
alter table "jwks" add column "alg" text;
alter table "jwks" add column "crv" text;
alter table "oauthClient" add column "clientDiscoveryId" text;
alter table "oauthClient" add column "clientCredentialsScopes" text;
alter table "oauthClient" add column "backchannelLogoutUri" text;
alter table "oauthClient" add column "backchannelLogoutSessionRequired" integer;
alter table "oauthClient" add column "applicationType" text;
alter table "oauthClient" add column "jwks" text;
alter table "oauthClient" add column "jwksUri" text;
alter table "oauthClient" add column "dpopBoundAccessTokens" integer default 0;
alter table "oauthRefreshToken" add column "authorizationCodeId" text;
alter table "oauthRefreshToken" add column "resources" text;
alter table "oauthRefreshToken" add column "requestedUserInfoClaims" text;
alter table "oauthRefreshToken" add column "rotatedAt" integer;
alter table "oauthRefreshToken" add column "rotationReplayResponse" text;
alter table "oauthRefreshToken" add column "rotationReplayExpiresAt" integer;
alter table "oauthRefreshToken" add column "confirmation" text;
alter table "oauthAccessToken" add column "authorizationCodeId" text;
alter table "oauthAccessToken" add column "resources" text;
alter table "oauthAccessToken" add column "requestedUserInfoClaims" text;
alter table "oauthAccessToken" add column "revoked" integer;
alter table "oauthAccessToken" add column "confirmation" text;
alter table "oauthConsent" add column "resources" text;
alter table "oauthConsent" add column "requestedUserInfoClaims" text;
create table "oauthResource" ("id" text not null primary key, "identifier" text not null unique, "name" text not null, "accessTokenTtl" integer, "refreshTokenTtl" integer, "signingAlgorithm" text, "signingKeyId" text, "allowedScopes" text, "customClaims" text, "dpopBoundAccessTokensRequired" integer, "disabled" integer, "createdAt" integer, "updatedAt" integer, "policyVersion" integer, "metadata" text);
create table "oauthClientResource" ("id" text not null primary key, "clientId" text not null references "oauthClient" ("clientId") on delete cascade, "resourceId" text not null references "oauthResource" ("identifier") on delete cascade, "metadata" text, "createdAt" integer);
create table "oauthClientAssertion" ("id" text not null primary key, "expiresAt" integer not null);
create index "oauthRefreshToken_authorizationCodeId_idx" on "oauthRefreshToken" ("authorizationCodeId");
create index "oauthAccessToken_authorizationCodeId_idx" on "oauthAccessToken" ("authorizationCodeId");
create index "oauthClientResource_clientId_idx" on "oauthClientResource" ("clientId");
create index "oauthClientResource_resourceId_idx" on "oauthClientResource" ("resourceId");
create unique index "oauthClientResource_clientId_resourceId_uidx" on "oauthClientResource" ("clientId", "resourceId");
