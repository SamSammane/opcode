# Implementation Plan 3: Performance Optimizations

**Priority:** HIGH
**Estimated Time:** 2-3 weeks
**Expected Impact:** 10-100x improvements in critical paths

---

## Overview

Optimize database queries, fix N+1 patterns, improve bundle size, and enhance React rendering performance.

---

## Part 1: Quick Wins (Day 1, 2-3 hours)

### 1.1 Add Database Indexes (CRITICAL - 15 minutes)

**File:** `src-tauri/src/commands/agents.rs`
**Impact:** 10-100x query speedup

#### Current Problem:
```rust
// Line 578-580: Query without indexes
let mut stmt = conn.prepare(
    "SELECT * FROM agent_runs WHERE agent_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?"
)?;
```

No indexes on `agent_id` or `created_at` means full table scans.

#### Implementation:

**Step 1:** Add index creation function
```rust
// Add to src-tauri/src/commands/agents.rs after table creation

fn create_indexes(conn: &Connection) -> Result<(), rusqlite::Error> {
    log::info!("Creating database indexes...");

    // Agent runs indexes
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_agent_runs_agent_id
         ON agent_runs(agent_id)",
        [],
    )?;

    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_agent_runs_created_at
         ON agent_runs(created_at DESC)",
        [],
    )?;

    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_agent_runs_status
         ON agent_runs(status)",
        [],
    )?;

    // Composite index for common query pattern
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_agent_runs_agent_status_date
         ON agent_runs(agent_id, status, created_at DESC)",
        [],
    )?;

    // Agents table indexes
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_agents_created_at
         ON agents(created_at DESC)",
        [],
    )?;

    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_agents_name
         ON agents(name)",
        [],
    )?;

    log::info!("Database indexes created successfully");
    Ok(())
}
```

**Step 2:** Call in init_database
```rust
// In init_database function (around line 220)
pub async fn init_database(app: &AppHandle) -> Result<Connection, String> {
    // ... existing table creation code ...

    // Create indexes AFTER tables
    create_indexes(&conn)
        .map_err(|e| format!("Failed to create indexes: {}", e))?;

    Ok(conn)
}
```

**Step 3:** Verify index usage
```rust
// Add to tests
#[cfg(test)]
mod performance_tests {
    #[tokio::test]
    async fn test_indexes_exist() {
        let conn = init_database(&test_app).await.unwrap();

        let mut stmt = conn.prepare(
            "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='agent_runs'"
        ).unwrap();

        let indexes: Vec<String> = stmt
            .query_map([], |row| row.get(0))
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap();

        assert!(indexes.contains(&"idx_agent_runs_agent_id".to_string()));
        assert!(indexes.contains(&"idx_agent_runs_created_at".to_string()));
    }
}
```

**Validation:**
```bash
# Before and after comparison
sqlite3 agents.db "EXPLAIN QUERY PLAN SELECT * FROM agent_runs WHERE agent_id = 1 ORDER BY created_at DESC"

# Before: SCAN TABLE agent_runs
# After:  SEARCH TABLE agent_runs USING INDEX idx_agent_runs_agent_status_date
```

---

### 1.2 Fix N+1 Agent Runs Query (30 minutes)

**File:** `src-tauri/src/commands/agents.rs`
**Lines:** 664-677
**Impact:** 10-50x speedup for listing agent runs

#### Current Code (N+1 Problem):
```rust
pub async fn list_agent_runs_with_metrics(
    db: State<'_, AgentDb>,
    agent_id: Option<i64>,
) -> Result<Vec<AgentRunWithMetrics>, String> {
    let runs = list_agent_runs(db, agent_id).await?;
    let mut runs_with_metrics = Vec::new();

    for run in runs {  // SEQUENTIAL file reads!
        let run_with_metrics = get_agent_run_with_metrics(run).await;
        runs_with_metrics.push(run_with_metrics);
    }

    Ok(runs_with_metrics)
}
```

Each `get_agent_run_with_metrics` does file I/O sequentially.

#### Fix with Parallel Processing:

```rust
use futures::future::join_all;

pub async fn list_agent_runs_with_metrics(
    db: State<'_, AgentDb>,
    agent_id: Option<i64>,
) -> Result<Vec<AgentRunWithMetrics>, String> {
    let runs = list_agent_runs(db, agent_id).await?;

    // Process all runs in parallel
    let metrics_futures: Vec<_> = runs
        .into_iter()
        .map(|run| {
            tokio::spawn(async move {
                get_agent_run_with_metrics(run).await
            })
        })
        .collect();

    // Wait for all to complete
    let results = join_all(metrics_futures).await;

    let runs_with_metrics = results
        .into_iter()
        .filter_map(|r| r.ok())
        .collect();

    Ok(runs_with_metrics)
}
```

**Benchmark:**
```rust
#[cfg(test)]
mod benchmarks {
    use std::time::Instant;

    #[tokio::test]
    async fn benchmark_parallel_vs_sequential() {
        // Create 50 test runs
        let runs = create_test_runs(50);

        // Sequential
        let start = Instant::now();
        let _ = list_agent_runs_with_metrics_sequential(runs.clone()).await;
        let sequential_time = start.elapsed();

        // Parallel
        let start = Instant::now();
        let _ = list_agent_runs_with_metrics(runs).await;
        let parallel_time = start.elapsed();

        println!("Sequential: {:?}", sequential_time);
        println!("Parallel: {:?}", parallel_time);
        println!("Speedup: {:.2}x", sequential_time.as_secs_f64() / parallel_time.as_secs_f64());

        // Assert at least 5x improvement
        assert!(sequential_time > parallel_time * 5);
    }
}
```

---

### 1.3 Lazy Load Heavy Dependencies (1 hour)

**File:** `package.json`
**Impact:** 15-20% bundle size reduction

#### Current Problem:
```json
"@uiw/react-md-editor": "^4.0.7"  // ~150KB, used in 2 components
```

#### Implementation:

**Step 1:** Create lazy-loaded wrapper
```typescript
// src/components/MarkdownEditor.lazy.tsx
import { lazy, Suspense } from 'react'
import { Skeleton } from '@/components/ui/skeleton'

const MarkdownEditor = lazy(() => import('./MarkdownEditor'))

export const LazyMarkdownEditor = (props: any) => {
  return (
    <Suspense
      fallback={
        <div className="space-y-2">
          <Skeleton className="h-8 w-full" />
          <Skeleton className="h-64 w-full" />
        </div>
      }
    >
      <MarkdownEditor {...props} />
    </Suspense>
  )
}
```

**Step 2:** Update imports
```typescript
// src/components/ClaudeFileEditor.tsx
// Before:
// import { MarkdownEditor } from './MarkdownEditor'

// After:
import { LazyMarkdownEditor as MarkdownEditor } from './MarkdownEditor.lazy'
```

**Step 3:** Apply to other heavy components
```typescript
// Heavy components to lazy load:
export const LazyRecharts = lazy(() => import('recharts'))
export const LazyCodeEditor = lazy(() => import('@uiw/react-md-editor'))
export const LazyDiffViewer = lazy(() => import('./DiffViewer'))
```

**Step 4:** Measure bundle impact
```bash
bun run build
bun add -D vite-bundle-visualizer

# Add to vite.config.ts
import { visualizer } from 'rollup-plugin-visualizer'

export default defineConfig({
  plugins: [
    react(),
    visualizer({ open: true, gzipSize: true })
  ]
})
```

---

## Part 2: Database Optimizations (Week 1, 8-10 hours)

### 2.1 Cache Project Paths (HIGH IMPACT)

**Files:** `src-tauri/src/commands/claude.rs`
**Lines:** 332-407, 485-495
**Impact:** Eliminate redundant file I/O

#### Current Problem:
```rust
// In list_projects - reads JSONL to get path
let project_path = match get_project_path_from_sessions(&path) {
    Ok(path) => path,
    // ...
};

// Later in get_project_sessions - READS SAME FILES AGAIN
let project_path = match get_project_path_from_sessions(&project_dir) {
    Ok(path) => path,
    // ...
};
```

#### Solution: Metadata Cache

**Step 1:** Create metadata structure
```rust
// src-tauri/src/project_cache.rs
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;
use tokio::sync::RwLock;
use std::time::{SystemTime, Duration};

#[derive(Debug, Clone, Serialize, Deserialize)]
struct ProjectMetadata {
    project_id: String,
    project_path: String,
    last_updated: SystemTime,
}

pub struct ProjectCache {
    cache: RwLock<HashMap<String, ProjectMetadata>>,
    ttl: Duration,
}

impl ProjectCache {
    pub fn new(ttl_seconds: u64) -> Self {
        Self {
            cache: RwLock::new(HashMap::new()),
            ttl: Duration::from_secs(ttl_seconds),
        }
    }

    pub async fn get(&self, project_id: &str) -> Option<String> {
        let cache = self.cache.read().await;

        if let Some(metadata) = cache.get(project_id) {
            // Check if expired
            if metadata.last_updated.elapsed().unwrap() < self.ttl {
                return Some(metadata.project_path.clone());
            }
        }

        None
    }

    pub async fn set(&self, project_id: String, project_path: String) {
        let mut cache = self.cache.write().await;

        cache.insert(project_id.clone(), ProjectMetadata {
            project_id,
            project_path,
            last_updated: SystemTime::now(),
        });
    }

    pub async fn invalidate(&self, project_id: &str) {
        let mut cache = self.cache.write().await;
        cache.remove(project_id);
    }

    pub async fn clear_expired(&self) {
        let mut cache = self.cache.write().await;

        cache.retain(|_, metadata| {
            metadata.last_updated.elapsed().unwrap() < self.ttl
        });
    }
}

// Global cache instance
lazy_static::lazy_static! {
    pub static ref PROJECT_CACHE: ProjectCache = ProjectCache::new(300); // 5 min TTL
}
```

**Step 2:** Update list_projects to use cache
```rust
// In src-tauri/src/commands/claude.rs

async fn get_project_path_cached(
    project_id: &str,
    project_dir: &Path
) -> Result<String, String> {
    // Check cache first
    if let Some(cached_path) = PROJECT_CACHE.get(project_id).await {
        return Ok(cached_path);
    }

    // Cache miss - read from disk
    let path = get_project_path_from_sessions(project_dir)?;

    // Update cache
    PROJECT_CACHE.set(project_id.to_string(), path.clone()).await;

    Ok(path)
}

// Update list_projects
#[tauri::command]
pub async fn list_projects() -> Result<Vec<Project>, String> {
    // ... existing code ...

    for entry in entries.flatten() {
        let path = entry.path();
        let dir_name = path.file_name()...;

        // Use cached version
        let project_path = match get_project_path_cached(&dir_name, &path).await {
            Ok(path) => path,
            Err(e) => decode_project_path(&dir_name),
        };

        // ...
    }
}
```

**Step 3:** Invalidate cache on session changes
```rust
#[tauri::command]
pub async fn execute_claude(...) -> Result<(), String> {
    // ... execute claude ...

    // Invalidate cache after new session
    PROJECT_CACHE.invalidate(&project_id).await;

    Ok(())
}
```

---

### 2.2 Optimize Session File Reads

**File:** `src-tauri/src/commands/claude.rs`
**Lines:** 500-545

#### Current: Synchronous I/O
```rust
if let Ok(session_entries) = fs::read_dir(&path) {
    for session_entry in session_entries.flatten() {
        if let Ok(metadata) = fs::metadata(&session_path) {  // Blocking!
            // ...
        }
    }
}
```

#### Fix: Async I/O
```rust
use tokio::fs;

pub async fn get_project_sessions(
    project_id: String,
) -> Result<Vec<Session>, String> {
    let claude_dir = get_claude_dir()?;
    let project_dir = claude_dir.join(&project_id);

    let mut entries = fs::read_dir(&project_dir)
        .await
        .map_err(|e| format!("Failed to read directory: {}", e))?;

    let mut sessions = Vec::new();

    while let Some(entry) = entries.next_entry().await.transpose() {
        let entry = entry.map_err(|e| format!("Failed to read entry: {}", e))?;
        let path = entry.path();

        if path.extension() == Some(std::ffi::OsStr::new("jsonl")) {
            // Async metadata
            if let Ok(metadata) = fs::metadata(&path).await {
                let modified = metadata.modified()
                    .ok()
                    .and_then(|m| m.duration_since(UNIX_EPOCH).ok())
                    .map(|d| d.as_secs())
                    .unwrap_or(0);

                sessions.push(Session {
                    // ...
                });
            }
        }
    }

    Ok(sessions)
}
```

---

## Part 3: React Performance (Week 2, 10-12 hours)

### 3.1 Memoize Heavy Components

**File:** `src/components/AgentRunsList.tsx`

#### Current: Re-renders on every parent update
```typescript
export const AgentRunsList = ({ runs, onSelect }: Props) => {
  // No memoization
  return (
    <div>
      {runs.map(run => (
        <AgentRunItem key={run.id} run={run} onSelect={onSelect} />
      ))}
    </div>
  )
}
```

#### Fix: React.memo + useMemo + useCallback
```typescript
import { memo, useMemo, useCallback } from 'react'

interface Props {
  runs: AgentRun[]
  onSelect: (run: AgentRun) => void
}

export const AgentRunsList = memo(({ runs, onSelect }: Props) => {
  // Memoize sorted runs
  const sortedRuns = useMemo(() => {
    return [...runs].sort((a, b) =>
      new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
    )
  }, [runs])

  // Memoize callback
  const handleSelect = useCallback((run: AgentRun) => {
    onSelect(run)
  }, [onSelect])

  return (
    <div>
      {sortedRuns.map(run => (
        <AgentRunItem
          key={run.id}
          run={run}
          onSelect={handleSelect}
        />
      ))}
    </div>
  )
})

// Memoize child component
const AgentRunItem = memo(({ run, onSelect }: ItemProps) => {
  const handleClick = useCallback(() => {
    onSelect(run)
  }, [run, onSelect])

  return (
    <div onClick={handleClick}>
      {/* ... */}
    </div>
  )
})
```

---

### 3.2 Virtual Scrolling for Large Lists

**File:** `src/components/AgentRunsList.tsx`

#### Install dependency (already in package.json):
```bash
bun add @tanstack/react-virtual
```

#### Implementation:
```typescript
import { useVirtualizer } from '@tanstack/react-virtual'
import { useRef } from 'react'

export const AgentRunsList = ({ runs }: Props) => {
  const parentRef = useRef<HTMLDivElement>(null)

  const virtualizer = useVirtualizer({
    count: runs.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 80, // Estimated row height
    overscan: 5, // Render 5 extra items
  })

  return (
    <div ref={parentRef} className="h-[600px] overflow-auto">
      <div
        style={{
          height: `${virtualizer.getTotalSize()}px`,
          width: '100%',
          position: 'relative',
        }}
      >
        {virtualizer.getVirtualItems().map((virtualItem) => {
          const run = runs[virtualItem.index]

          return (
            <div
              key={virtualItem.key}
              style={{
                position: 'absolute',
                top: 0,
                left: 0,
                width: '100%',
                height: `${virtualItem.size}px`,
                transform: `translateY(${virtualItem.start}px)`,
              }}
            >
              <AgentRunItem run={run} />
            </div>
          )
        })}
      </div>
    </div>
  )
}
```

**Impact:** Render 10-20 items instead of 1000+

---

### 3.3 Optimize UsageDashboard Calculations

**File:** `src/components/UsageDashboard.tsx`
**Lines:** 45-89

#### Move constants outside component:
```typescript
// BEFORE: Recreated on every render
const getModelDisplayName = useCallback((model: string): string => {
  const modelMap: Record<string, string> = {  // Bad!
    "claude-4-opus": "Opus 4",
    // ...
  };
  return modelMap[model] || model;
}, []);

// AFTER: Define once
const MODEL_DISPLAY_NAMES: Record<string, string> = {
  "claude-4-opus": "Opus 4",
  "claude-4-sonnet": "Sonnet 4",
  "claude-sonnet-4": "Sonnet 4",
  "claude-sonnet-4-5": "Sonnet 4.5",
}

const MODEL_PRICES: Record<string, { input: number; output: number }> = {
  "claude-4-opus": { input: 0.015, output: 0.075 },
  "claude-4-sonnet": { input: 0.003, output: 0.015 },
}

export const UsageDashboard = () => {
  const getModelDisplayName = useCallback((model: string) => {
    return MODEL_DISPLAY_NAMES[model] || model
  }, [])

  const calculateCost = useCallback((usage: Usage) => {
    const prices = MODEL_PRICES[usage.model]
    if (!prices) return 0

    return (
      (usage.input_tokens / 1_000_000) * prices.input +
      (usage.output_tokens / 1_000_000) * prices.output
    )
  }, [])

  // ...
}
```

---

### 3.4 Debounce Expensive Operations

**File:** `src/components/FilePicker.tsx`

```typescript
import { useDebouncedValue } from '@/hooks/useDebouncedValue'

export const FilePicker = () => {
  const [searchQuery, setSearchQuery] = useState('')

  // Debounce search to avoid excessive filtering
  const debouncedSearch = useDebouncedValue(searchQuery, 300)

  const filteredFiles = useMemo(() => {
    if (!debouncedSearch) return files

    return files.filter(file =>
      file.name.toLowerCase().includes(debouncedSearch.toLowerCase())
    )
  }, [files, debouncedSearch])

  return (
    <div>
      <input
        value={searchQuery}
        onChange={(e) => setSearchQuery(e.target.value)}
        placeholder="Search files..."
      />
      {/* Render filteredFiles */}
    </div>
  )
}
```

---

## Part 4: Bundle Optimization (Week 2, 4-6 hours)

### 4.1 Code Splitting Configuration

**File:** `vite.config.ts`

```typescript
export default defineConfig({
  build: {
    rollupOptions: {
      output: {
        manualChunks: {
          // Core vendor
          'vendor-react': ['react', 'react-dom'],

          // UI library
          'vendor-ui': [
            '@radix-ui/react-dialog',
            '@radix-ui/react-dropdown-menu',
            '@radix-ui/react-select',
            '@radix-ui/react-tabs',
          ],

          // Heavy dependencies
          'markdown': ['react-markdown', '@uiw/react-md-editor'],
          'charts': ['recharts'],
          'animation': ['framer-motion'],
          'analytics': ['posthog-js'],

          // Feature-based chunks
          'agents': [
            './src/components/CCAgents',
            './src/components/AgentExecution',
            './src/components/AgentRunsList',
          ],
          'sessions': [
            './src/components/ClaudeCodeSession',
            './src/components/SessionList',
          ],
          'mcp': [
            './src/components/MCPManager',
            './src/components/MCPAddServer',
          ],
        },
      },
    },
    // Increase chunk size warning limit
    chunkSizeWarningLimit: 1000,
  },
})
```

---

### 4.2 Tree Shaking Optimization

**Check imports:**
```bash
# Find barrel imports (bad for tree shaking)
grep -r "import \* as" src/
```

**Fix barrel imports:**
```typescript
// BEFORE (imports entire library):
import * as Icons from 'lucide-react'

// AFTER (tree-shakeable):
import { Check, X, AlertCircle } from 'lucide-react'
```

---

## Benchmarking & Monitoring

### Performance Metrics to Track

```typescript
// src/lib/performance.ts
export class PerformanceMonitor {
  static measure(name: string, fn: () => void) {
    const start = performance.now()
    fn()
    const duration = performance.now() - start

    console.log(`[PERF] ${name}: ${duration.toFixed(2)}ms`)

    // Send to analytics
    if (duration > 1000) {
      console.warn(`Slow operation: ${name}`)
    }
  }

  static async measureAsync<T>(name: string, fn: () => Promise<T>): Promise<T> {
    const start = performance.now()
    const result = await fn()
    const duration = performance.now() - start

    console.log(`[PERF] ${name}: ${duration.toFixed(2)}ms`)

    return result
  }
}

// Usage:
await PerformanceMonitor.measureAsync('list_projects', async () => {
  return await api.listProjects()
})
```

---

## Success Criteria

✅ Database queries use indexes (10-100x faster)
✅ Agent runs load in < 300ms (from 3-5s)
✅ Bundle size reduced by 15-20%
✅ Large lists use virtual scrolling
✅ Heavy components lazy loaded
✅ No unnecessary re-renders
✅ Async I/O for all file operations
✅ Performance monitoring in place

---

## Performance Budget

| Metric | Target | Critical Threshold |
|--------|--------|-------------------|
| Initial Load | < 2s | < 3s |
| List Projects | < 200ms | < 500ms |
| List Agent Runs | < 300ms | < 1s |
| Load Session | < 500ms | < 1s |
| Bundle Size | < 800KB | < 1MB |
| Time to Interactive | < 3s | < 5s |

---

## Monitoring in Production

```typescript
// src/lib/analytics.ts
export function trackPerformance(metric: string, value: number) {
  // Send to PostHog or logging service
  posthog.capture('performance_metric', {
    metric,
    value,
    timestamp: Date.now(),
  })

  // Alert if threshold exceeded
  const thresholds = {
    'list_projects': 500,
    'list_agent_runs': 1000,
    'bundle_size': 1024 * 1024,
  }

  if (value > thresholds[metric]) {
    console.error(`Performance threshold exceeded: ${metric} = ${value}`)
  }
}
```
