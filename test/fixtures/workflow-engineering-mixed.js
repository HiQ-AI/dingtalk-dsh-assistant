import { readTaskOwnerStageArtifacts } from '../../packages/dingtalk-dsh-assistant/task-owner-controller.js'
import test from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, writeFile, readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { assertEngineeringStageRepository, selectTaskLocalAcceptance, createEngineeringStageContract, createEngineeringRegistry, readEngineeringDeliveryProof, readEngineeringRemoteRefs, uatBranchFor, isUatBranch, engineeringWorkflowOwnerContract, createEngineeringCompletionPolicy } from '../../packages/dingtalk-dsh-assistant/workflow-engineering.js'
import { createTaskWorkflowContracts } from '../../packages/dingtalk-dsh-assistant/task-workflow-contracts.js'
import { openExecutionStore } from '../../packages/dingtalk-dsh-assistant/execution-store.js'
import { defineExecutionWorkflow } from '../../packages/dingtalk-dsh-assistant/execution-controller.js'
import { executionDigest } from '../../packages/dingtalk-dsh-assistant/execution-artifacts.js'
import { openExecutionArtifacts } from '../../packages/dingtalk-dsh-assistant/execution-artifacts.js'
import { createManagedWorkspaces } from '../../packages/dingtalk-dsh-assistant/execution-workspace.js'


// Registration-only fixtures explicitly provide the current local-acceptance capability.
// Delivery tests below retain their real HTTP service and executable scenarios.
function registryLocalFixture(directory) {
  const command = { executable: process.execPath, args: ['-e', 'process.exit(0)'] }
  return { version: 'registry-fixture', sharedDataProfilePath: join(directory, 'profile.json'), prepareSteps: [],
    service: { ...command, args: [...command.args, '127.0.0.1', '{port}'], readyPath: '/' },
    scenarios: [{ id: 'registry', description: 'registration-only capability', expected: 'registered', ...command }],
    cleanup: command, verifyCleanup: command }
}











// 两代均完整实跑 Git、候选服务验收及 PR 投递，每代沿用 240 秒预算。

























































export { readTaskOwnerStageArtifacts, assert, execFile, promisify, createHash, mkdir, mkdtemp, writeFile, readdir, readFile, join, tmpdir, assertEngineeringStageRepository, selectTaskLocalAcceptance, createEngineeringStageContract, createEngineeringRegistry, readEngineeringDeliveryProof, readEngineeringRemoteRefs, uatBranchFor, isUatBranch, engineeringWorkflowOwnerContract, createEngineeringCompletionPolicy, createTaskWorkflowContracts, openExecutionStore, defineExecutionWorkflow, executionDigest, openExecutionArtifacts, createManagedWorkspaces, registryLocalFixture }
