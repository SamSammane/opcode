# Implementation Plan 1: Security Fixes

**Priority:** CRITICAL
**Estimated Time:** 8-12 hours
**Owner:** Backend/Security Team

---

## Overview

Fix critical security vulnerabilities including SQL injection, missing authentication, panic-inducing code, and insecure configurations.

---

## Part 1: SQL Injection Fixes (3-4 hours)

### 1.1 Fix Arbitrary SQL Execution (CRITICAL)

**File:** `src-tauri/src/commands/storage.rs`
**Lines:** 381-448

#### Current Code (VULNERABLE):
```rust
#[tauri::command]
pub async fn storage_execute_sql(
    db: State<'_, AgentDb>,
    query: String,
) -> Result<QueryResult, String> {
    let is_select = query.trim().to_uppercase().starts_with("SELECT");
    // Executes ANY query!
```

#### Implementation Steps:

**Step 1:** Create query validation function
```rust
// Add at top of storage.rs
const ALLOWED_KEYWORDS: &[&str] = &["SELECT"];
const FORBIDDEN_KEYWORDS: &[&str] = &[
    "DROP", "DELETE", "UPDATE", "INSERT", "ALTER",
    "CREATE", "EXEC", "EXECUTE", "PRAGMA", "ATTACH"
];

fn validate_read_only_query(query: &str) -> Result<(), String> {
    let trimmed = query.trim().to_uppercase();

    // Must start with SELECT
    if !trimmed.starts_with("SELECT") {
        return Err("Only SELECT queries are allowed".to_string());
    }

    // Check for forbidden keywords
    for keyword in FORBIDDEN_KEYWORDS {
        if trimmed.contains(keyword) {
            return Err(format!("Query contains forbidden keyword: {}", keyword));
        }
    }

    // Limit query length to prevent DoS
    if query.len() > 10_000 {
        return Err("Query too long (max 10,000 characters)".to_string());
    }

    Ok(())
}
```

**Step 2:** Update `storage_execute_sql` function
```rust
#[tauri::command]
pub async fn storage_execute_sql(
    db: State<'_, AgentDb>,
    query: String,
) -> Result<QueryResult, String> {
    // VALIDATE FIRST
    validate_read_only_query(&query)?;

    let db = db.0.lock().await;

    let mut stmt = db
        .prepare(&query)
        .map_err(|e| {
            log::error!("Failed to prepare query: {}", e);
            "Failed to prepare query".to_string()
        })?;

    // Rest of implementation...
}
```

**Testing:**
```rust
// Add to src-tauri/tests/security_tests.rs
#[cfg(test)]
mod sql_injection_tests {
    use super::*;

    #[test]
    fn test_blocks_delete() {
        let query = "DELETE FROM agents WHERE 1=1";
        assert!(validate_read_only_query(query).is_err());
    }

    #[test]
    fn test_blocks_drop() {
        let query = "SELECT * FROM agents; DROP TABLE agents;";
        assert!(validate_read_only_query(query).is_err());
    }

    #[test]
    fn test_allows_select() {
        let query = "SELECT * FROM agents WHERE id = 1";
        assert!(validate_read_only_query(query).is_ok());
    }
}
```

---

### 1.2 Fix Column Name Injection

**File:** `src-tauri/src/commands/storage.rs`
**Lines:** 250-264, 308-315

#### Current Code (VULNERABLE):
```rust
let set_clauses: Vec<String> = updates.keys()
    .map(|(idx, key)| format!("{} = ?{}", key, idx + 1))  // Direct interpolation!
    .collect();
```

#### Implementation Steps:

**Step 1:** Add column validation function
```rust
fn validate_column_names(
    conn: &Connection,
    table_name: &str,
    column_names: &[String]
) -> Result<(), String> {
    // Get actual table columns
    let mut stmt = conn
        .prepare(&format!("PRAGMA table_info('{}')", table_name))
        .map_err(|e| format!("Failed to get table info: {}", e))?;

    let valid_columns: Vec<String> = stmt
        .query_map([], |row| row.get::<_, String>(1))
        .map_err(|e| format!("Failed to query columns: {}", e))?
        .filter_map(Result::ok)
        .collect();

    // Validate all requested columns exist
    for col in column_names {
        if !valid_columns.contains(col) {
            return Err(format!("Invalid column name: {}", col));
        }
    }

    Ok(())
}
```

**Step 2:** Update `storage_update_row` function
```rust
#[tauri::command]
pub async fn storage_update_row(
    db: State<'_, AgentDb>,
    table_name: String,
    row_id: i64,
    updates: HashMap<String, Value>,
) -> Result<(), String> {
    is_valid_table_name(&table_name)?;

    let db = db.0.lock().await;

    // VALIDATE COLUMNS
    let column_names: Vec<String> = updates.keys().cloned().collect();
    validate_column_names(&db, &table_name, &column_names)?;

    // Now safe to use in query
    let set_clauses: Vec<String> = updates.keys()
        .enumerate()
        .map(|(idx, key)| format!("{} = ?{}", key, idx + 2))
        .collect();

    // Rest of implementation...
}
```

**Step 3:** Apply same fix to DELETE
```rust
#[tauri::command]
pub async fn storage_delete_row(
    db: State<'_, AgentDb>,
    table_name: String,
    conditions: HashMap<String, Value>,
) -> Result<(), String> {
    is_valid_table_name(&table_name)?;

    let db = db.0.lock().await;

    // VALIDATE COLUMNS
    let column_names: Vec<String> = conditions.keys().cloned().collect();
    validate_column_names(&db, &table_name, &column_names)?;

    // Rest of implementation...
}
```

---

### 1.3 Fix LIKE Clause Injection

**File:** `src-tauri/src/commands/storage.rs`
**Line:** 152

#### Current Code (VULNERABLE):
```rust
.map(|col| format!("{} LIKE '%{}%'", col.name, search.replace("'", "''")))
```

#### Fix:
```rust
// Use parameterized queries instead
let where_clauses: Vec<String> = columns
    .iter()
    .enumerate()
    .map(|(idx, col)| format!("{} LIKE ?{}", col.name, idx + 3))
    .collect();

// Then bind parameters:
for (idx, _) in columns.iter().enumerate() {
    stmt = stmt.bind((idx + 3) as i32, &format!("%{}%", search))?;
}
```

---

## Part 2: Authentication & Authorization (4-5 hours)

### 2.1 Implement Token-Based Authentication

**File:** `src-tauri/src/web_server.rs`

#### Implementation Steps:

**Step 1:** Add dependencies to `Cargo.toml`
```toml
[dependencies]
jsonwebtoken = "9"
rand = "0.8"
```

**Step 2:** Create auth module
```rust
// src-tauri/src/auth.rs
use jsonwebtoken::{encode, decode, Header, Validation, EncodingKey, DecodingKey};
use serde::{Deserialize, Serialize};
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Debug, Serialize, Deserialize)]
pub struct Claims {
    pub sub: String,  // Subject (user identifier)
    pub exp: usize,   // Expiration time
    pub iat: usize,   // Issued at
}

pub struct AuthConfig {
    secret: String,
}

impl AuthConfig {
    pub fn new() -> Self {
        // In production, load from environment or config file
        let secret = std::env::var("OPCODE_SECRET")
            .unwrap_or_else(|_| {
                // Generate random secret on first run
                use rand::Rng;
                let secret: String = rand::thread_rng()
                    .sample_iter(&rand::distributions::Alphanumeric)
                    .take(32)
                    .map(char::from)
                    .collect();

                log::warn!("No OPCODE_SECRET found, generated random secret");
                log::warn!("Set OPCODE_SECRET env var for persistent auth");
                secret
            });

        Self { secret }
    }

    pub fn generate_token(&self, user_id: &str) -> Result<String, String> {
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_secs() as usize;

        let claims = Claims {
            sub: user_id.to_string(),
            exp: now + 86400, // 24 hours
            iat: now,
        };

        encode(
            &Header::default(),
            &claims,
            &EncodingKey::from_secret(self.secret.as_bytes())
        ).map_err(|e| format!("Failed to generate token: {}", e))
    }

    pub fn validate_token(&self, token: &str) -> Result<Claims, String> {
        decode::<Claims>(
            token,
            &DecodingKey::from_secret(self.secret.as_bytes()),
            &Validation::default()
        )
        .map(|data| data.claims)
        .map_err(|e| format!("Invalid token: {}", e))
    }
}
```

**Step 3:** Create auth middleware
```rust
// src-tauri/src/auth_middleware.rs
use axum::{
    extract::State,
    http::{Request, StatusCode},
    middleware::Next,
    response::Response,
};
use crate::auth::AuthConfig;

pub async fn auth_middleware<B>(
    State(auth_config): State<AuthConfig>,
    mut req: Request<B>,
    next: Next<B>,
) -> Result<Response, StatusCode> {
    // Check for Authorization header
    let auth_header = req
        .headers()
        .get("Authorization")
        .and_then(|h| h.to_str().ok());

    let token = match auth_header {
        Some(auth) if auth.starts_with("Bearer ") => {
            &auth[7..] // Skip "Bearer "
        }
        _ => {
            log::warn!("Missing or invalid Authorization header");
            return Err(StatusCode::UNAUTHORIZED);
        }
    };

    // Validate token
    match auth_config.validate_token(token) {
        Ok(claims) => {
            // Store user info in request extensions
            req.extensions_mut().insert(claims);
            Ok(next.run(req).await)
        }
        Err(e) => {
            log::warn!("Token validation failed: {}", e);
            Err(StatusCode::UNAUTHORIZED)
        }
    }
}
```

**Step 4:** Update web server
```rust
// src-tauri/src/web_server.rs
use crate::auth::{AuthConfig, Claims};
use crate::auth_middleware::auth_middleware;

pub async fn start_web_server(port: u16, app_handle: AppHandle) -> Result<(), String> {
    let auth_config = AuthConfig::new();

    // Public routes (no auth required)
    let public_routes = Router::new()
        .route("/health", get(|| async { "OK" }))
        .route("/auth/token", post(generate_auth_token));

    // Protected routes (auth required)
    let protected_routes = Router::new()
        .route("/projects", get(list_projects_handler))
        .route("/sessions/:session_id", get(get_session_handler))
        .route("/agents", get(list_agents_handler))
        // ... all other routes
        .layer(axum::middleware::from_fn_with_state(
            auth_config.clone(),
            auth_middleware
        ));

    let app = Router::new()
        .merge(public_routes)
        .merge(protected_routes)
        .layer(cors)
        .with_state(auth_config);

    // Rest of implementation...
}

// Add token generation endpoint
async fn generate_auth_token(
    State(auth_config): State<AuthConfig>,
    // In production, validate credentials here
) -> Result<Json<TokenResponse>, StatusCode> {
    // For now, generate token for "local" user
    // TODO: Add proper user authentication
    let token = auth_config
        .generate_token("local")
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    Ok(Json(TokenResponse { token }))
}

#[derive(Serialize)]
struct TokenResponse {
    token: String,
}
```

**Step 5:** Update frontend to use auth
```typescript
// src/lib/apiAdapter.ts

let authToken: string | null = null;

async function getAuthToken(): Promise<string> {
    if (authToken) return authToken;

    // Get token from backend
    const response = await fetch(`${API_BASE_URL}/auth/token`, {
        method: 'POST',
    });

    if (!response.ok) {
        throw new Error('Failed to get auth token');
    }

    const { token } = await response.json();
    authToken = token;
    return token;
}

async function restApiCall<T>(endpoint: string, params?: any): Promise<T> {
    const token = await getAuthToken();

    const response = await fetch(`${API_BASE_URL}${endpoint}`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${token}`,
        },
        body: JSON.stringify(params),
    });

    // Handle 401 - token expired
    if (response.status === 401) {
        authToken = null; // Clear token
        return restApiCall<T>(endpoint, params); // Retry with new token
    }

    // Rest of implementation...
}
```

---

## Part 3: Fix Panic-Inducing Code (1-2 hours)

### 3.1 Replace expect() Calls

**Files:** `src-tauri/src/main.rs`, `src-tauri/src/commands/agents.rs`

#### Find all expect() calls:
```bash
cd src-tauri
grep -rn "\.expect(" src/
```

#### Replacement Pattern:

**Before:**
```rust
let conn = init_database(&app.handle())
    .expect("Failed to initialize agents database");
```

**After:**
```rust
let conn = init_database(&app.handle())
    .map_err(|e| {
        log::error!("Failed to initialize agents database: {}", e);
        e.to_string()
    })?;
```

#### Specific Fixes:

**File:** `src-tauri/src/main.rs` (Line 63, 120)
```rust
// In setup closure
fn setup(app: &mut App) -> Result<(), Box<dyn std::error::Error>> {
    // Before:
    // init_database(&app.handle()).expect("Failed to initialize agents database");

    // After:
    if let Err(e) = init_database(&app.handle()) {
        log::error!("Failed to initialize database: {}", e);
        return Err(Box::new(e));
    }

    Ok(())
}
```

**File:** `src-tauri/src/main.rs` (Line 180 - Window Vibrancy)
```rust
#[cfg(target_os = "macos")]
fn apply_vibrancy(window: &Window) -> Result<(), String> {
    use window_vibrancy::{apply_vibrancy, NSVisualEffectMaterial};

    // Before:
    // apply_vibrancy(window, NSVisualEffectMaterial::HudWindow, None, None)
    //     .expect("Failed to apply any window vibrancy");

    // After:
    if let Err(e) = apply_vibrancy(window, NSVisualEffectMaterial::HudWindow, None, None) {
        log::warn!("Failed to apply window vibrancy: {}", e);
        // Don't fail app startup for cosmetic feature
    }
    Ok(())
}
```

**File:** `src-tauri/src/commands/agents.rs` (Lines 221-222, 862, 1499)
```rust
// Before:
// let app_dir = app_data_dir().expect("Failed to get app data dir");
// std::fs::create_dir_all(&app_dir).expect("Failed to create app data dir");

// After:
let app_dir = app_data_dir()
    .ok_or_else(|| "Failed to get app data directory".to_string())?;

std::fs::create_dir_all(&app_dir)
    .map_err(|e| format!("Failed to create app data directory: {}", e))?;
```

---

## Part 4: Secure CORS Configuration (30 minutes)

**File:** `src-tauri/src/web_server.rs`
**Line:** 776-779

#### Current Code (INSECURE):
```rust
let cors = CorsLayer::new()
    .allow_origin(Any)  // DANGEROUS!
    .allow_methods([Method::GET, Method::POST, Method::PUT, Method::DELETE])
    .allow_headers(Any);
```

#### Fix:
```rust
use tower_http::cors::{CorsLayer, AllowOrigin};
use http::header;

let allowed_origins = vec![
    "http://localhost:1420".parse().unwrap(),
    "http://127.0.0.1:1420".parse().unwrap(),
    "https://localhost:1420".parse().unwrap(),
];

let cors = CorsLayer::new()
    .allow_origin(AllowOrigin::list(allowed_origins))
    .allow_methods([Method::GET, Method::POST])
    .allow_headers([
        header::CONTENT_TYPE,
        header::AUTHORIZATION,
    ])
    .allow_credentials(true)
    .max_age(Duration::from_secs(3600));
```

---

## Part 5: Fix CSP Configuration (15 minutes)

**File:** `src-tauri/tauri.conf.json`
**Line:** 27

#### Current Code (INSECURE):
```json
"csp": "default-src 'self'; ... style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-eval' ..."
```

#### Fix:
```json
{
  "csp": {
    "default-src": "'self'",
    "img-src": "'self' asset: https://asset.localhost blob: data:",
    "style-src": "'self'",
    "script-src": "'self' https://app.posthog.com",
    "connect-src": "'self' ipc: https://ipc.localhost https://app.posthog.com",
    "font-src": "'self'",
    "object-src": "'none'",
    "frame-ancestors": "'none'",
    "base-uri": "'self'",
    "form-action": "'self'"
  }
}
```

**Note:** If removing `unsafe-inline` breaks styles, use CSS-in-JS with nonces:
```typescript
// src/main.tsx
const nonce = Math.random().toString(36).substring(2);
document.querySelector('meta[property="csp-nonce"]')?.setAttribute('content', nonce);
```

---

## Part 6: Path Traversal Protection (1 hour)

**File:** `src-tauri/src/commands/agents.rs`
**Lines:** 177-178

#### Add validation function:
```rust
use std::path::{Path, PathBuf};

fn validate_safe_path(base: &Path, path: &Path) -> Result<PathBuf, String> {
    // Canonicalize both paths
    let canonical_base = base
        .canonicalize()
        .map_err(|e| format!("Invalid base path: {}", e))?;

    let canonical_path = path
        .canonicalize()
        .or_else(|_| {
            // If path doesn't exist yet, check parent
            if let Some(parent) = path.parent() {
                parent.canonicalize()
                    .map(|p| p.join(path.file_name().unwrap()))
            } else {
                Err(std::io::Error::new(
                    std::io::ErrorKind::NotFound,
                    "Invalid path"
                ))
            }
        })
        .map_err(|e| format!("Invalid path: {}", e))?;

    // Ensure canonical path is within base
    if !canonical_path.starts_with(&canonical_base) {
        return Err("Path traversal attempt detected".to_string());
    }

    Ok(canonical_path)
}
```

#### Apply to session file access:
```rust
pub async fn get_agent_run_with_metrics(run: AgentRun) -> AgentRunWithMetrics {
    // ... existing code ...

    let session_file = project_dir.join(format!("{}.jsonl", run.session_id));

    // VALIDATE PATH
    if let Err(e) = validate_safe_path(&project_dir, &session_file) {
        log::error!("Path validation failed: {}", e);
        return AgentRunWithMetrics {
            // ... return with zero metrics
        };
    }

    // Rest of implementation...
}
```

---

## Testing & Validation

### Security Test Suite

**File:** `src-tauri/tests/security_tests.rs`
```rust
#[cfg(test)]
mod security_tests {
    use super::*;

    #[tokio::test]
    async fn test_sql_injection_blocked() {
        let queries = vec![
            "DELETE FROM agents",
            "DROP TABLE agents",
            "SELECT * FROM agents; DROP TABLE agents;",
            "INSERT INTO agents VALUES (1, 'evil')",
        ];

        for query in queries {
            assert!(
                validate_read_only_query(query).is_err(),
                "Should block: {}",
                query
            );
        }
    }

    #[tokio::test]
    async fn test_column_injection_blocked() {
        // Test that invalid column names are rejected
        // ... implementation
    }

    #[tokio::test]
    async fn test_path_traversal_blocked() {
        let base = PathBuf::from("/home/user/.claude");
        let malicious = PathBuf::from("/home/user/.claude/../../etc/passwd");

        assert!(validate_safe_path(&base, &malicious).is_err());
    }

    #[tokio::test]
    async fn test_auth_required() {
        // Test that endpoints reject requests without auth token
        // ... implementation
    }
}
```

### Manual Testing Checklist

- [ ] SQL injection attempts blocked
- [ ] Column name validation working
- [ ] Path traversal attempts blocked
- [ ] CORS only allows localhost
- [ ] Auth token required for protected endpoints
- [ ] Token expiration working
- [ ] No panics on invalid input
- [ ] CSP blocks inline scripts
- [ ] Error messages don't leak sensitive info

---

## Success Criteria

✅ Zero SQL injection vulnerabilities
✅ All `.expect()` calls replaced with proper error handling
✅ CORS restricted to localhost origins
✅ CSP blocks unsafe-inline and unsafe-eval
✅ Path traversal protection in place
✅ Authentication required for web server (if deployed)
✅ All security tests passing
✅ App doesn't panic on malicious input

---

## Rollback Plan

If issues occur:

1. Revert changes: `git revert <commit>`
2. Security fixes are in `src-tauri/src/commands/storage.rs`, `web_server.rs`, `main.rs`, `agents.rs`
3. Frontend auth changes in `src/lib/apiAdapter.ts`
4. Config changes in `tauri.conf.json`

---

## Next Steps

After completing these fixes:
1. Run security audit: `cargo audit`
2. Run tests: `cargo test`
3. Test manually with malicious inputs
4. Document security practices in SECURITY.md
5. Set up automated security scanning in CI/CD
