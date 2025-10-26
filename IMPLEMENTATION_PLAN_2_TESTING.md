# Implementation Plan 2: Testing Infrastructure

**Priority:** HIGH
**Estimated Time:** 3-4 weeks (for 60-70% coverage)
**Owner:** Full Team

---

## Overview

Establish comprehensive testing infrastructure from 0% to 60-70% coverage across 27,000+ lines of code. Focus on critical paths first, then expand coverage.

---

## Phase 1: Setup Testing Infrastructure (Week 1, 4-6 hours)

### 1.1 Frontend Testing Setup

**Step 1:** Install testing dependencies
```bash
bun add -D vitest @testing-library/react @testing-library/jest-dom @testing-library/user-event jsdom
bun add -D @vitest/ui happy-dom
```

**Step 2:** Create Vitest configuration
```typescript
// vitest.config.ts
import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import path from 'path'

export default defineConfig({
  plugins: [react()],
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: ['./src/tests/setup.ts'],
    include: ['src/**/*.{test,spec}.{ts,tsx}'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'lcov'],
      exclude: [
        'node_modules/',
        'src/tests/',
        '**/*.d.ts',
        '**/*.config.*',
        '**/mockData.ts',
        'src/main.tsx',
      ],
      thresholds: {
        statements: 60,
        branches: 50,
        functions: 60,
        lines: 60,
      },
    },
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
})
```

**Step 3:** Create test setup file
```typescript
// src/tests/setup.ts
import { expect, afterEach, vi } from 'vitest'
import { cleanup } from '@testing-library/react'
import * as matchers from '@testing-library/jest-dom/matchers'

// Extend Vitest matchers
expect.extend(matchers)

// Cleanup after each test
afterEach(() => {
  cleanup()
})

// Mock Tauri APIs globally
global.window = global.window || {}
global.window.__TAURI__ = {
  invoke: vi.fn(),
  listen: vi.fn(),
  emit: vi.fn(),
}

// Mock IntersectionObserver
global.IntersectionObserver = class IntersectionObserver {
  constructor() {}
  disconnect() {}
  observe() {}
  takeRecords() { return [] }
  unobserve() {}
}

// Mock ResizeObserver
global.ResizeObserver = class ResizeObserver {
  constructor() {}
  disconnect() {}
  observe() {}
  unobserve() {}
}
```

**Step 4:** Create test utilities
```typescript
// src/tests/utils.tsx
import { ReactElement } from 'react'
import { render, RenderOptions } from '@testing-library/react'
import { ThemeProvider } from '@/contexts/ThemeContext'
import { TabProvider } from '@/contexts/TabContext'

// Create AllTheProviders wrapper
const AllTheProviders = ({ children }: { children: React.ReactNode }) => {
  return (
    <ThemeProvider>
      <TabProvider>
        {children}
      </TabProvider>
    </ThemeProvider>
  )
}

// Custom render function
export const renderWithProviders = (
  ui: ReactElement,
  options?: Omit<RenderOptions, 'wrapper'>
) => render(ui, { wrapper: AllTheProviders, ...options })

// Re-export everything
export * from '@testing-library/react'
export { renderWithProviders as render }
```

**Step 5:** Create Tauri mock helpers
```typescript
// src/tests/tauriMocks.ts
import { vi } from 'vitest'

export const mockTauriInvoke = (responses: Record<string, any>) => {
  const invoke = vi.fn((command: string, args?: any) => {
    if (responses[command]) {
      if (typeof responses[command] === 'function') {
        return Promise.resolve(responses[command](args))
      }
      return Promise.resolve(responses[command])
    }
    return Promise.reject(new Error(`Unknown command: ${command}`))
  })

  window.__TAURI__.invoke = invoke
  return invoke
}

export const mockTauriListen = () => {
  const callbacks = new Map<string, Function[]>()

  const listen = vi.fn((event: string, callback: Function) => {
    if (!callbacks.has(event)) {
      callbacks.set(event, [])
    }
    callbacks.get(event)!.push(callback)

    return Promise.resolve(() => {
      const cbs = callbacks.get(event)
      if (cbs) {
        const index = cbs.indexOf(callback)
        if (index > -1) cbs.splice(index, 1)
      }
    })
  })

  const emit = (event: string, payload: any) => {
    const cbs = callbacks.get(event) || []
    cbs.forEach(cb => cb({ event, payload }))
  }

  window.__TAURI__.listen = listen
  window.__TAURI__.emit = emit

  return { listen, emit }
}
```

**Step 6:** Add test scripts to package.json
```json
{
  "scripts": {
    "test": "vitest",
    "test:ui": "vitest --ui",
    "test:coverage": "vitest run --coverage",
    "test:watch": "vitest --watch"
  }
}
```

---

### 1.2 Rust Testing Setup

**Step 1:** Install test runner
```bash
cargo install cargo-nextest --locked
cargo install cargo-tarpaulin  # For coverage
```

**Step 2:** Create test module structure
```bash
mkdir -p src-tauri/tests
touch src-tauri/tests/common.rs
```

**Step 3:** Create test helpers
```rust
// src-tauri/tests/common.rs
use rusqlite::Connection;
use tempfile::TempDir;
use std::path::PathBuf;

pub struct TestContext {
    pub temp_dir: TempDir,
    pub db: Connection,
}

impl TestContext {
    pub fn new() -> Self {
        let temp_dir = TempDir::new().unwrap();
        let db_path = temp_dir.path().join("test.db");
        let db = Connection::open(db_path).unwrap();

        Self { temp_dir, db }
    }

    pub fn claude_dir(&self) -> PathBuf {
        self.temp_dir.path().join(".claude")
    }

    pub fn setup_test_db(&self) {
        // Create test tables
        self.db.execute(
            "CREATE TABLE agents (
                id INTEGER PRIMARY KEY,
                name TEXT NOT NULL,
                prompt TEXT,
                created_at TEXT
            )",
            [],
        ).unwrap();

        self.db.execute(
            "CREATE TABLE agent_runs (
                id INTEGER PRIMARY KEY,
                agent_id INTEGER NOT NULL,
                status TEXT,
                created_at TEXT
            )",
            [],
        ).unwrap();
    }

    pub fn insert_test_agent(&self, name: &str) -> i64 {
        self.db.execute(
            "INSERT INTO agents (name, prompt, created_at) VALUES (?, ?, datetime('now'))",
            [name, "Test prompt"],
        ).unwrap();

        self.db.last_insert_rowid()
    }
}
```

**Step 4:** Configure Cargo.toml for testing
```toml
# src-tauri/Cargo.toml

[dev-dependencies]
tempfile = "3"
serial_test = "3"  # For tests that can't run in parallel
mockall = "0.13"   # For mocking

[profile.test]
opt-level = 0
debug = true
```

**Step 5:** Add test scripts
```bash
# Create justfile or add to existing
echo '
test:
    cargo nextest run

test-coverage:
    cargo tarpaulin --out Html --output-dir coverage

test-all:
    cargo nextest run && bun test
' >> justfile
```

---

## Phase 2: Critical Path Tests (Week 2, 12-16 hours)

### 2.1 API Adapter Tests (HIGH PRIORITY)

**File:** `src/lib/apiAdapter.test.ts`

```typescript
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mockTauriInvoke } from '@/tests/tauriMocks'
import { apiAdapter } from './apiAdapter'

describe('apiAdapter', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe('Environment Detection', () => {
    it('should detect Tauri environment', () => {
      window.__TAURI__ = { invoke: vi.fn() }
      expect(apiAdapter.isTauriEnvironment()).toBe(true)
    })

    it('should detect web environment', () => {
      delete window.__TAURI__
      expect(apiAdapter.isTauriEnvironment()).toBe(false)
    })
  })

  describe('Command Mapping', () => {
    it('should map list_projects to correct endpoint', async () => {
      const invoke = mockTauriInvoke({
        list_projects: [
          { id: '1', name: 'Test Project', path: '/test' }
        ]
      })

      const result = await apiAdapter.call('list_projects')

      expect(invoke).toHaveBeenCalledWith('list_projects', undefined)
      expect(result).toHaveLength(1)
      expect(result[0].name).toBe('Test Project')
    })

    it('should handle errors gracefully', async () => {
      mockTauriInvoke({
        list_projects: () => {
          throw new Error('Database error')
        }
      })

      await expect(
        apiAdapter.call('list_projects')
      ).rejects.toThrow('Database error')
    })
  })

  describe('Streaming Commands', () => {
    it('should handle streaming responses', async () => {
      const { emit } = mockTauriListen()
      const chunks: string[] = []

      apiAdapter.stream('execute_claude', {
        onChunk: (chunk) => chunks.push(chunk),
        onComplete: () => {},
        onError: () => {},
      })

      // Simulate streaming
      emit('claude-output', 'chunk1')
      emit('claude-output', 'chunk2')
      emit('claude-complete', null)

      expect(chunks).toEqual(['chunk1', 'chunk2'])
    })
  })
})
```

---

### 2.2 Custom Hooks Tests

**File:** `src/hooks/useApiCall.test.ts`

```typescript
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'
import { useApiCall } from './useApiCall'
import { mockTauriInvoke } from '@/tests/tauriMocks'

describe('useApiCall', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('should handle successful API call', async () => {
    mockTauriInvoke({
      list_projects: [{ id: '1', name: 'Project 1' }]
    })

    const { result } = renderHook(() =>
      useApiCall('list_projects')
    )

    expect(result.current.loading).toBe(true)

    await waitFor(() => {
      expect(result.current.loading).toBe(false)
    })

    expect(result.current.data).toHaveLength(1)
    expect(result.current.error).toBeNull()
  })

  it('should handle API errors', async () => {
    mockTauriInvoke({
      list_projects: () => {
        throw new Error('Network error')
      }
    })

    const { result } = renderHook(() =>
      useApiCall('list_projects')
    )

    await waitFor(() => {
      expect(result.current.loading).toBe(false)
    })

    expect(result.current.error).toBe('Network error')
    expect(result.current.data).toBeNull()
  })

  it('should support retry', async () => {
    let callCount = 0
    mockTauriInvoke({
      list_projects: () => {
        callCount++
        if (callCount < 3) {
          throw new Error('Temporary error')
        }
        return [{ id: '1' }]
      }
    })

    const { result } = renderHook(() =>
      useApiCall('list_projects', { retry: 3 })
    )

    await waitFor(() => {
      expect(result.current.loading).toBe(false)
    })

    expect(callCount).toBe(3)
    expect(result.current.data).toHaveLength(1)
  })
})
```

**File:** `src/hooks/useDebounce.test.ts`

```typescript
import { describe, it, expect, vi } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'
import { useDebounce } from './useDebounce'

describe('useDebounce', () => {
  it('should debounce value changes', async () => {
    vi.useFakeTimers()

    const { result, rerender } = renderHook(
      ({ value, delay }) => useDebounce(value, delay),
      { initialProps: { value: 'initial', delay: 500 } }
    )

    expect(result.current).toBe('initial')

    // Change value multiple times
    rerender({ value: 'change1', delay: 500 })
    rerender({ value: 'change2', delay: 500 })
    rerender({ value: 'final', delay: 500 })

    // Value should not change immediately
    expect(result.current).toBe('initial')

    // Fast-forward time
    vi.advanceTimersByTime(500)

    // Value should now be updated
    await waitFor(() => {
      expect(result.current).toBe('final')
    })

    vi.useRealTimers()
  })
})
```

---

### 2.3 Zustand Store Tests

**File:** `src/stores/agentStore.test.ts`

```typescript
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { renderHook, act, waitFor } from '@testing-library/react'
import { useAgentStore } from './agentStore'
import { mockTauriInvoke } from '@/tests/tauriMocks'

describe('agentStore', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    // Reset store
    useAgentStore.setState({
      runs: [],
      isLoadingRuns: false,
      error: null,
    })
  })

  it('should fetch agent runs', async () => {
    const mockRuns = [
      { id: 1, agent_id: 1, status: 'completed' },
      { id: 2, agent_id: 1, status: 'running' },
    ]

    mockTauriInvoke({
      list_agent_runs_with_metrics: mockRuns
    })

    const { result } = renderHook(() => useAgentStore())

    await act(async () => {
      await result.current.fetchAgentRuns(1)
    })

    expect(result.current.runs).toHaveLength(2)
    expect(result.current.isLoadingRuns).toBe(false)
  })

  it('should handle fetch errors', async () => {
    mockTauriInvoke({
      list_agent_runs_with_metrics: () => {
        throw new Error('Database error')
      }
    })

    const { result } = renderHook(() => useAgentStore())

    await act(async () => {
      await result.current.fetchAgentRuns(1)
    })

    expect(result.current.error).toBe('Failed to fetch agent runs')
    expect(result.current.runs).toHaveLength(0)
  })
})
```

---

### 2.4 Component Tests

**File:** `src/components/ProjectList.test.tsx`

```typescript
import { describe, it, expect, vi } from 'vitest'
import { render, screen, waitFor } from '@/tests/utils'
import { ProjectList } from './ProjectList'
import { mockTauriInvoke } from '@/tests/tauriMocks'

describe('ProjectList', () => {
  it('should render loading state', () => {
    render(<ProjectList onSelect={vi.fn()} />)
    expect(screen.getByText(/loading/i)).toBeInTheDocument()
  })

  it('should render projects', async () => {
    mockTauriInvoke({
      list_projects: [
        { id: 'proj1', name: 'Project 1', path: '/path1' },
        { id: 'proj2', name: 'Project 2', path: '/path2' },
      ]
    })

    render(<ProjectList onSelect={vi.fn()} />)

    await waitFor(() => {
      expect(screen.getByText('Project 1')).toBeInTheDocument()
      expect(screen.getByText('Project 2')).toBeInTheDocument()
    })
  })

  it('should call onSelect when project is clicked', async () => {
    const onSelect = vi.fn()

    mockTauriInvoke({
      list_projects: [
        { id: 'proj1', name: 'Project 1', path: '/path1' },
      ]
    })

    render(<ProjectList onSelect={onSelect} />)

    await waitFor(() => {
      expect(screen.getByText('Project 1')).toBeInTheDocument()
    })

    await userEvent.click(screen.getByText('Project 1'))

    expect(onSelect).toHaveBeenCalledWith({
      id: 'proj1',
      name: 'Project 1',
      path: '/path1'
    })
  })

  it('should display error message', async () => {
    mockTauriInvoke({
      list_projects: () => {
        throw new Error('Failed to load')
      }
    })

    render(<ProjectList onSelect={vi.fn()} />)

    await waitFor(() => {
      expect(screen.getByText(/failed to load/i)).toBeInTheDocument()
    })
  })
})
```

---

### 2.5 Rust Command Tests

**File:** `src-tauri/src/commands/agents.rs`

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use crate::tests::common::TestContext;

    #[tokio::test]
    async fn test_create_agent() {
        let ctx = TestContext::new();
        ctx.setup_test_db();

        let agent = Agent {
            id: None,
            name: "Test Agent".to_string(),
            prompt: Some("Test prompt".to_string()),
            icon: None,
            color: None,
            model: Some("sonnet".to_string()),
            default_task: None,
            hooks: None,
            read_permissions: None,
            write_permissions: None,
            network_access: Some(false),
            created_at: None,
        };

        let result = create_agent_impl(&ctx.db, agent).await;
        assert!(result.is_ok());

        let created = result.unwrap();
        assert_eq!(created.name, "Test Agent");
        assert!(created.id.is_some());
    }

    #[tokio::test]
    async fn test_list_agents() {
        let ctx = TestContext::new();
        ctx.setup_test_db();
        ctx.insert_test_agent("Agent 1");
        ctx.insert_test_agent("Agent 2");

        let result = list_agents_impl(&ctx.db).await;
        assert!(result.is_ok());

        let agents = result.unwrap();
        assert_eq!(agents.len(), 2);
    }

    #[tokio::test]
    async fn test_delete_agent() {
        let ctx = TestContext::new();
        ctx.setup_test_db();
        let agent_id = ctx.insert_test_agent("Agent to Delete");

        let result = delete_agent_impl(&ctx.db, agent_id).await;
        assert!(result.is_ok());

        // Verify deleted
        let agents = list_agents_impl(&ctx.db).await.unwrap();
        assert_eq!(agents.len(), 0);
    }
}
```

**File:** `src-tauri/src/checkpoint/manager.rs`

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use crate::tests::common::TestContext;
    use std::fs;

    #[tokio::test]
    async fn test_create_checkpoint() {
        let ctx = TestContext::new();
        let storage = CheckpointStorage::new(ctx.claude_dir());

        // Create test project directory
        let project_dir = ctx.claude_dir().join("test-project");
        fs::create_dir_all(&project_dir).unwrap();
        fs::write(project_dir.join("test.txt"), "content").unwrap();

        let checkpoint = Checkpoint {
            id: "ckpt1".to_string(),
            session_id: "session1".to_string(),
            message: "Test checkpoint".to_string(),
            created_at: chrono::Utc::now(),
            files: vec![],
        };

        let result = storage.save_checkpoint(&checkpoint, &project_dir).await;
        assert!(result.is_ok());

        // Verify checkpoint exists
        let loaded = storage.load_checkpoint("ckpt1").await;
        assert!(loaded.is_ok());
        assert_eq!(loaded.unwrap().message, "Test checkpoint");
    }

    #[tokio::test]
    async fn test_restore_checkpoint() {
        // Test checkpoint restoration
        // ... implementation
    }
}
```

---

## Phase 3: Integration Tests (Week 3, 10-12 hours)

### 3.1 End-to-End Session Flow

**File:** `src-tauri/tests/integration_session.rs`

```rust
mod common;

use common::TestContext;

#[tokio::test]
async fn test_complete_session_flow() {
    let ctx = TestContext::new();

    // 1. Create project
    let project = create_project(&ctx, "Test Project").await;

    // 2. Start session
    let session = start_session(&ctx, &project.id).await;
    assert_eq!(session.status, "running");

    // 3. Send messages
    send_message(&ctx, &session.id, "Test message").await;

    // 4. Create checkpoint
    let checkpoint = create_checkpoint(&ctx, &session.id, "Test checkpoint").await;
    assert!(checkpoint.files.len() > 0);

    // 5. Restore checkpoint
    restore_checkpoint(&ctx, &checkpoint.id).await;

    // 6. Stop session
    stop_session(&ctx, &session.id).await;
    let final_session = get_session(&ctx, &session.id).await;
    assert_eq!(final_session.status, "completed");
}
```

### 3.2 Agent Execution Integration

**File:** `src-tauri/tests/integration_agent.rs`

```rust
#[tokio::test]
async fn test_agent_execution_flow() {
    let ctx = TestContext::new();

    // 1. Create agent
    let agent = create_test_agent(&ctx, "Test Agent").await;

    // 2. Execute agent
    let run = execute_agent(&ctx, agent.id, "Test task").await;
    assert_eq!(run.status, "running");

    // 3. Wait for completion (with timeout)
    let completed_run = wait_for_completion(&ctx, run.id, Duration::from_secs(30)).await;
    assert_eq!(completed_run.status, "completed");

    // 4. Verify metrics calculated
    let metrics = get_run_metrics(&ctx, run.id).await;
    assert!(metrics.message_count > 0);
}
```

---

## Phase 4: Expand Coverage (Week 4, 8-10 hours)

### 4.1 UI Component Tests

Test all major components:
- `ClaudeCodeSession.test.tsx`
- `AgentExecution.test.tsx`
- `TimelineNavigator.test.tsx`
- `MCPManager.test.tsx`
- `UsageDashboard.test.tsx`

### 4.2 Service Tests

Test business logic:
- `sessionPersistence.test.ts`
- `tabPersistence.test.ts`
- Analytics service tests

### 4.3 Edge Cases

Test error conditions:
- Network failures
- Invalid input
- Race conditions
- Memory limits

---

## Testing Best Practices

### DO:
✅ Test behavior, not implementation
✅ Use descriptive test names
✅ Arrange-Act-Assert pattern
✅ Mock external dependencies
✅ Test error cases
✅ Keep tests isolated
✅ Use factories for test data

### DON'T:
❌ Test internal implementation details
❌ Write tests that depend on each other
❌ Use real file system in unit tests
❌ Make network calls in tests
❌ Hardcode timing assumptions
❌ Test framework code

---

## Coverage Goals

| Component | Target Coverage | Priority |
|-----------|----------------|----------|
| API Adapter | 90% | Critical |
| Hooks | 85% | High |
| Stores | 85% | High |
| Commands (Rust) | 75% | High |
| Checkpoint System | 80% | High |
| UI Components | 60% | Medium |
| Utilities | 70% | Medium |

---

## CI/CD Integration

**File:** `.github/workflows/test.yml`

```yaml
name: Tests

on:
  push:
    branches: [main, develop]
  pull_request:
    branches: [main]

jobs:
  test-frontend:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3
      - uses: oven-sh/setup-bun@v1
      - run: bun install
      - run: bun test:coverage
      - uses: codecov/codecov-action@v3
        with:
          files: ./coverage/lcov.info
          flags: frontend

  test-backend:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3
      - uses: actions-rs/toolchain@v1
        with:
          toolchain: stable
      - run: cargo install cargo-nextest
      - run: cargo nextest run
      - run: cargo tarpaulin --out Xml
      - uses: codecov/codecov-action@v3
        with:
          files: ./cobertura.xml
          flags: backend
```

---

## Success Criteria

✅ All test frameworks installed and configured
✅ 60-70% code coverage achieved
✅ All critical paths have tests
✅ Integration tests for key workflows
✅ CI/CD pipeline running tests automatically
✅ Coverage reports generated
✅ Zero flaky tests
✅ Test suite runs in < 5 minutes

---

## Maintenance

After initial setup:
1. Require tests for new features
2. Maintain coverage thresholds
3. Review and update tests during refactoring
4. Monitor test performance
5. Keep dependencies updated
