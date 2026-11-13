import type { Config } from '../config.ts';
import { SCOPE } from './errors.ts';

/** RFC 8414 authorization server metadata. The control plane is the issuer for every resource of the platform. */
export function authorizationServerMetadata(config: Pick<Config, 'controlOrigin'>) {
  const base = config.controlOrigin;
  return {
    issuer: base,
    authorization_endpoint: `${base}/oauth/authorize`,
    token_endpoint: `${base}/oauth/token`,
    registration_endpoint: `${base}/oauth/register`,
    revocation_endpoint: `${base}/oauth/revoke`,
    response_types_supported: ['code'],
    response_modes_supported: ['query'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none', 'client_secret_post', 'client_secret_basic'],
    revocation_endpoint_auth_methods_supported: ['none', 'client_secret_post', 'client_secret_basic'],
    scopes_supported: [SCOPE],
    client_id_metadata_document_supported: true,
    authorization_response_iss_parameter_supported: true,
  };
}

/** RFC 9728 protected resource metadata for one MCP endpoint (`resource` is its canonical URI). */
export function protectedResourceMetadata(config: Pick<Config, 'controlOrigin'>, resource: string, name: string) {
  return {
    resource,
    authorization_servers: [config.controlOrigin],
    scopes_supported: [SCOPE],
    bearer_methods_supported: ['header'],
    resource_name: name,
  };
}

/**
 * Where a resource's metadata is published (RFC 9728 §3.1): on the resource's own origin,
 * the well-known segment inserted in front of its path. A resource that is a bare origin
 * loses its terminating slash.
 */
export function protectedResourceMetadataUrl(resource: string): string {
  const url = new URL(resource);
  const path = url.pathname === '/' ? '' : url.pathname;
  return `${url.origin}/.well-known/oauth-protected-resource${path}${url.search}`;
}
