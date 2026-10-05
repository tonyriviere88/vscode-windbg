import { DebugSession } from '@vscode/debugadapter';
import { WinDbgSession } from './session';

// Standalone entry point: speaks DAP over stdin/stdout.
DebugSession.run(WinDbgSession);
