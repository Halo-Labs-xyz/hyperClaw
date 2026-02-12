#!/usr/bin/env node
/**
 * Deploy Public HyperClaw Agents to Unibase AIP Platform
 * 
 * Usage: node scripts/deploy-public-agents.js [options]
 * 
 * Options:
 *   --agent-id <id>    Deploy specific agent by ID
 *   --all              Deploy all active agents
 *   --endpoint <url>   Public endpoint URL (overrides env var)
 * 
 * Environment Variables Required:
 *   - AIP_ENDPOINT: AIP platform API URL
 *   - GATEWAY_URL: Gateway URL
 *   - AGENT_PUBLIC_URL: Your public endpoint URL (or use --endpoint)
 *   - MEMBASE_ACCOUNT: Wallet address for payments/memory
 */

import { registerAIPAgent, registerAllActiveAgents, checkAIPHealth } from "../lib/unibase-aip";

const args = process.argv.slice(2);

function parseArgs() {
  const options = {
    agentId: null,
    all: false,
    endpoint: process.env.AGENT_PUBLIC_URL || null,
  };

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--agent-id':
        options.agentId = args[++i];
        break;
      case '--all':
        options.all = true;
        break;
      case '--endpoint':
        options.endpoint = args[++i];
        break;
      case '--help':
        console.log(`
Deploy Public HyperClaw Agents to Unibase AIP Platform

Usage: node scripts/deploy-public-agents.js [options]

Options:
  --agent-id <id>    Deploy specific agent by ID
  --all              Deploy all active agents
  --endpoint <url>   Public endpoint URL (overrides env var)
  --help             Show this help message

Environment Variables Required:
  AIP_ENDPOINT         AIP platform API URL
  GATEWAY_URL          Gateway URL
  AGENT_PUBLIC_URL     Your public endpoint URL (or use --endpoint)
  MEMBASE_ACCOUNT      Wallet address for payments/memory

Examples:
  # Deploy all active agents
  node scripts/deploy-public-agents.js --all --endpoint https://hyperclaw.com/api/unibase

  # Deploy specific agent
  node scripts/deploy-public-agents.js --agent-id abc123 --endpoint https://hyperclaw.com/api/unibase
        `);
        process.exit(0);
    }
  }

  return options;
}

async function main() {
  console.log('🚀 HyperClaw → Unibase AIP Deployment (PUBLIC Mode)\n');

  // Parse arguments
  const options = parseArgs();

  // Validate environment
  const requiredEnv = ['AIP_ENDPOINT', 'GATEWAY_URL', 'MEMBASE_ACCOUNT'];
  const missing = requiredEnv.filter(key => !process.env[key]);
  
  if (missing.length > 0) {
    console.error('❌ Missing required environment variables:', missing.join(', '));
    process.exit(1);
  }

  if (!options.endpoint) {
    console.error('❌ Public endpoint URL required (use --endpoint or set AGENT_PUBLIC_URL)');
    process.exit(1);
  }

  if (!options.agentId && !options.all) {
    console.error('❌ Must specify --agent-id or --all');
    process.exit(1);
  }

  console.log('Environment Configuration:');
  console.log(`  AIP Endpoint:    ${process.env.AIP_ENDPOINT}`);
  console.log(`  Gateway URL:     ${process.env.GATEWAY_URL}`);
  console.log(`  Public Endpoint: ${options.endpoint}`);
  console.log(`  Wallet:          ${process.env.MEMBASE_ACCOUNT}\n`);

  // Health check
  console.log('Step 1: Checking AIP Platform Health...');
  const health = await checkAIPHealth();
  if (!health.healthy) {
    console.error('❌ AIP platform is not healthy');
    process.exit(1);
  }
  console.log('✅ AIP platform is healthy\n');

  // Deploy agents
  console.log('Step 2: Registering Agents...');
  
  if (options.all) {
    console.log('Registering all active agents...');
    const results = await registerAllActiveAgents('DIRECT', options.endpoint);
    
    console.log(`\n✅ Successfully registered ${results.length} agents:\n`);
    results.forEach((r, i) => {
      console.log(`${i + 1}. ${r.config.name}`);
      console.log(`   AIP Agent ID: ${r.aipAgentId}`);
      console.log(`   Handle:       @${r.config.handle}`);
      console.log(`   Endpoint:     ${r.config.endpoint_url}`);
      console.log(`   Cost:         $${r.config.cost_model.base_call_fee} per call`);
      console.log(`   Skills:       ${r.config.skills.length} skills`);
      console.log('');
    });
  } else if (options.agentId) {
    const publicEndpoint = `${options.endpoint}/invoke/${options.agentId}`;
    const { aipAgentId, config } = await registerAIPAgent(
      options.agentId,
      'DIRECT',
      publicEndpoint
    );

    console.log(`\n✅ Successfully registered agent:\n`);
    console.log(`   Name:         ${config.name}`);
    console.log(`   AIP Agent ID: ${aipAgentId}`);
    console.log(`   Handle:       @${config.handle}`);
    console.log(`   Endpoint:     ${config.endpoint_url}`);
    console.log(`   Cost:         $${config.cost_model.base_call_fee} per call`);
    console.log(`   Skills:       ${config.skills.map(s => s.name).join(', ')}`);
    console.log('');
  }

  console.log('✅ Deployment complete!\n');
  console.log('Next steps:');
  console.log('  1. Start your agent service: npm run dev');
  console.log('  2. Ensure your public endpoint is accessible');
  console.log('  3. Test agent invocation via AIP Gateway');
  console.log('  4. Monitor agent logs for incoming requests\n');
}

main().catch(error => {
  console.error('\n❌ Deployment failed:', error);
  process.exit(1);
});
