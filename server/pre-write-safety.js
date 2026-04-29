'use strict';

const fs = require('fs');
const path = require('path');
const libDir = path.resolve(__dirname, '..', 'hooks', 'lib');
const { normalizePath } = require(path.join(libDir, 'glob-match'));
const IS_WIN = process.platform === 'win32';

const DEFAULT_SAFETY_RULES = {
  prodFactories: ['prd'],
  prodConnections: ['prd', 'ferconlineprod'],
  prodEnvironments: ['ferc', 'spprod', 'PRODSPO', 'hotlineprod', 'doidms', 'galprod'],
  prodDeployStepTypes: ['adf-deploy-pipeline', 'sql-deploy-sp', 'adf-run-pipeline', 'adf-run-and-wait', 'adf-sandbox-run-and-wait'],
  prodMutationStepTypes: ['sql-deploy-sp'],
  prodUriPatterns: [
    'ferc.crm9.dynamics.com', 'almsptier3prod.crm9.dynamics.com', 'orgc37aa7be.crm9.dynamics.com',
    'hotlineprod.crm9.dynamics.com', 'doidms.crm9.dynamics.com', 'galprod.crm9.dynamics.com',
    'fercalmstagingprd.database.usgovcloudapi.net', 'FDC1S-FOLSQLP2'
  ],
  devRevertAllowedFactories: ['dev1'],
  blockedExportBranches: ['main', 'master'],
  readOnlyStepTypes: [
    'sql-query', 'sql-file', 'dataverse-query', 'dataverse-file',
    'schema-pull', 'schema-index', 'adf-pull', 'adf-pull-all',
    'sql-schema-pull', 'sql-schema-pull-all', 'work-repo-diff',
    'adf-query-runs', 'adf-activity-errors', 'adf-trigger-status',
    'adf-export-errors', 'adf-trace-run'
  ],
  prodUriRegex: 'ferc\\.crm9|hotlineprod\\.crm9|doidms\\.crm9|galprod\\.crm9|orgc37aa7be\\.crm9|almsptier3prod\\.crm9',
  prodNameRegex: '\\bprod\\b|PRODSPO|spprod'
};

function loadSafetyRules(projectDir) {
  if (!projectDir) return DEFAULT_SAFETY_RULES;
  const rulesPath = path.join(projectDir, '.claude', 'safety-rules.json');
  try {
    const data = JSON.parse(fs.readFileSync(rulesPath, 'utf8'));
    // Merge with defaults — each field falls back to default if missing
    const merged = {};
    for (const key of Object.keys(DEFAULT_SAFETY_RULES)) {
      merged[key] = data[key] != null ? data[key] : DEFAULT_SAFETY_RULES[key];
    }
    return merged;
  } catch {
    return DEFAULT_SAFETY_RULES;
  }
}

function preWriteDeny(reason) {
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: 'SAFETY: ' + reason
    }
  };
}

function preWriteAsk(reason) {
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'ask',
      permissionDecisionReason: 'SAFETY: ' + reason
    }
  };
}

function validateTaskSteps(content, rules, projectDir) {
  let task;
  try {
    task = JSON.parse(content);
  } catch {
    return null; // Malformed JSON — allow (same as shell script)
  }

  const steps = task.steps || [];
  const prodFactories = rules.prodFactories || [];
  const prodConns = rules.prodConnections || [];
  const prodEnvs = rules.prodEnvironments || [];
  const prodDeployTypes = rules.prodDeployStepTypes || [];
  const prodMutationTypes = rules.prodMutationStepTypes || [];
  const prodUriPatterns = rules.prodUriPatterns || [];
  const devRevertAllowed = rules.devRevertAllowedFactories || [];
  const readOnly = rules.readOnlyStepTypes || [];
  const blockedBranches = rules.blockedExportBranches || [];
  const prodUriRe = new RegExp(rules.prodUriRegex || '', 'i');

  // Load connections.json for URI resolution
  let dvEnvs = {};
  if (projectDir) {
    try {
      const connPath = path.join(projectDir, 'connections.json');
      const connData = JSON.parse(fs.readFileSync(connPath, 'utf8'));
      dvEnvs = connData.dataverse || {};
    } catch {}
  }

  function envUriIsProd(envName) {
    const env = dvEnvs[envName];
    if (!env || !env.url) return false;
    return prodUriPatterns.some(p => env.url.toLowerCase().includes(p.toLowerCase()));
  }

  for (const s of steps) {
    const ty = s.type || '';

    // Read-only SQL query with DML/DDL check
    if (ty === 'sql-query' && s.connection && prodConns.includes(s.connection)) {
      if (s.sql && /\b(INSERT|UPDATE|DELETE|MERGE|TRUNCATE|DROP|ALTER|CREATE|EXEC)\b/i.test(s.sql)) {
        return { decision: 'deny', reason: 'Step ' + ty + ' contains DML/DDL targeting production connection ' + s.connection };
      }
      return { decision: 'ask', reason: 'Step ' + ty + ' targets production connection ' + s.connection };
    }

    if (readOnly.includes(ty)) continue;

    // dev-revert factory check
    if (ty === 'dev-revert' && s.factory && !devRevertAllowed.includes(s.factory)) {
      return { decision: 'deny', reason: 'dev-revert only allowed against factory ' + devRevertAllowed.join('/') + ' -- not ' + s.factory };
    }

    // Factory check
    if (s.factory && prodFactories.includes(s.factory)) {
      if (prodDeployTypes.includes(ty)) {
        return { decision: 'deny', reason: 'Step ' + ty + ' targets production factory ' + s.factory };
      }
      return { decision: 'ask', reason: 'Step ' + ty + ' targets production factory ' + s.factory };
    }

    // Connection check
    if (s.connection && prodConns.includes(s.connection)) {
      if (prodMutationTypes.includes(ty) || prodDeployTypes.includes(ty)) {
        return { decision: 'deny', reason: 'Step ' + ty + ' targets production connection ' + s.connection };
      }
      return { decision: 'ask', reason: 'Step ' + ty + ' targets production connection ' + s.connection };
    }

    // Environment check
    if (s.environment && prodEnvs.includes(s.environment)) {
      return { decision: 'deny', reason: 'Step ' + ty + ' targets production environment ' + s.environment };
    }

    // URI-based environment check
    if (s.environment && envUriIsProd(s.environment)) {
      return { decision: 'deny', reason: 'Step ' + ty + ' targets environment ' + s.environment + ' (resolves to prod URI)' };
    }

    // run-script file content check
    if (ty === 'run-script' && s.file && projectDir) {
      try {
        const scriptPath = path.resolve(projectDir, s.file);
        if (fs.existsSync(scriptPath)) {
          const scriptContent = fs.readFileSync(scriptPath, 'utf8');
          if (prodUriRe.test(scriptContent)) {
            return { decision: 'ask', reason: 'Script ' + s.file + ' contains production URI patterns' };
          }
        }
      } catch {}
    }

    // work-repo-export branch check
    if (ty === 'work-repo-export' && s.branch && blockedBranches.includes(s.branch)) {
      return { decision: 'deny', reason: 'work-repo-export targets blocked branch ' + s.branch + ' -- use a feature branch' };
    }
  }

  return null; // All steps OK
}

function validateSecurityModelConfig(content, rules) {
  const prodUriRe = new RegExp(rules.prodUriRegex || DEFAULT_SAFETY_RULES.prodUriRegex, 'i');
  const prodNameRe = new RegExp(rules.prodNameRegex || DEFAULT_SAFETY_RULES.prodNameRegex, 'i');

  // Extract (env_name, dv_name, _, uri) tuples from SQL INSERT VALUES
  const tupleRe = /\(\s*'([^']+)'\s*,\s*'([^']+)'\s*,\s*'([^']+)'\s*,\s*'([^']+)'/g;
  let m;
  while ((m = tupleRe.exec(content)) !== null) {
    const envName = m[1];
    const dvName = m[2];
    const svcUri = m[4];

    const isProdOrg = prodNameRe.test(dvName) || prodUriRe.test(svcUri);

    if (isProdOrg) {
      if (envName === 'prod') {
        // OK
      } else if (envName === 'dataqa') {
        return { decision: 'ask', reason: "Prod org '" + dvName + "' under environment_name='dataqa' — confirm this is intentional." };
      } else {
        return { decision: 'deny', reason: "Prod org '" + dvName + "' (URI: " + svcUri + ") under environment_name='" + envName + "' — must be under 'prod'" };
      }
    }

    // Dev URI under prod env check
    if (/dev\.crm9|almwave3|almappdev1|lms-dev/i.test(svcUri)) {
      if (envName === 'prod') {
        return { decision: 'deny', reason: "Dev URI '" + svcUri + "' under environment_name='prod' — wrong environment" };
      }
    }
  }

  return null; // All tuples OK
}

function handlePreWrite(input, projectRoot) {
  const toolInput = input && input.tool_input;
  if (!toolInput) return {};

  const filePath = toolInput.file_path || toolInput.file || '';
  if (!filePath) return {};

  // Normalize to forward slashes
  const normalized = normalizePath(filePath);

  // Get relative path by stripping up to the project dir
  let relPath = normalized;
  const projectDir = projectRoot;
  if (projectDir) {
    const rootTest = IS_WIN ? projectDir.toLowerCase() : projectDir;
    const pathTest = IS_WIN ? normalized.toLowerCase() : normalized;
    if (pathTest.startsWith(rootTest + '/')) {
      relPath = normalized.slice(projectDir.length + 1);
    }
  }

  // Fast exit: only inspect risky paths
  let check = null;
  if (/^tasks\/.*\.json$/.test(relPath)) {
    check = 'task';
  } else if (/work-repo-staging\/.*ADFCreateAndPopulateSecurityModelConfig/.test(relPath)) {
    check = 'secmodel';
  }

  if (!check) return {};

  // Extract content from the tool input
  const content = toolInput.content || toolInput.new_string || '';
  if (!content) return {};

  // Load safety rules from project dir
  const rules = loadSafetyRules(projectDir);

  if (check === 'task') {
    const result = validateTaskSteps(content, rules, projectDir);
    if (result) {
      return result.decision === 'deny' ? preWriteDeny(result.reason) : preWriteAsk(result.reason);
    }
  }

  if (check === 'secmodel') {
    const result = validateSecurityModelConfig(content, rules);
    if (result) {
      return result.decision === 'deny' ? preWriteDeny(result.reason) : preWriteAsk(result.reason);
    }
  }

  return {};
}

module.exports = { handlePreWrite, DEFAULT_SAFETY_RULES, loadSafetyRules, validateTaskSteps, validateSecurityModelConfig };
