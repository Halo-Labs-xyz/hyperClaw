#!/usr/bin/env node
/**
 * Deploy Private HyperClaw Agents to Unibase AIP Platform
 * 
 * Usage: node scripts/deploy-private-agents.js [options]
 * 
 * Options:
 *   --agent-id <id>    Deploy specific agent by ID
 *   --all              Deploy all active agents
 *   --poll-interval    Polling interval in seconds (default: 5)
 * 
 * Environment Variables Required:
 *   - AIP_ENDPOINT: AIP platform API URL
 *   - GATEWAY_URL: Gateway URL
 *   - MEMBASE_ACCOUNT: Wallet address for payments/memory
 * 
 * Private Mode Benefits:
 *   ✅ No public endpoint required
 *   ✅ Works behind firewall/NAT
 *   ✅ Enhanced security (no inbound connections)
 *   ✅ Perfect for local/private networks
 */

import { registerAIPAgent, registerAllActiveAgents, checkAIPHealth, pollGatewayTasks, submitTaskResult, invokeAIPAgent } from "../lib/unibase-aip";

const args = process.argv.slice(2);

function parseArgs() {
  const options = {
    agentId: null as string | null,
    all: false,
    pollInterval: 5, // seconds
  };

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--agent-id':
        options.agentId = args[++i];
        break;
      case '--all':
        options.all = true;
        break;
      case '--poll-interval':
        options.pollInterval = parseInt(args[++i], 10);
        break;
      case '--help':
        console.log(`
Deploy Private HyperClaw Agents to Unibase AIP Platform

Usage: node scripts/deploy-private-agents.js [options]

Options:
  --agent-id <id>      Deploy specific agent by ID
  --all                Deploy all active agents
  --poll-interval <s>  Polling interval in seconds (default: 5)
  --help               Show this help message

Environment Variables Required:
  AIP_ENDPOINT         AIP platform API URL
  GATEWAY_URL          Gateway URL
  MEMBASE_ACCOUNT      Wallet address for payments/memory

Private Mode Benefits:
  ✅ No public endpoint required
  ✅ Works behind firewall/NAT
  ✅ Enhanced security (no inbound connections)
  ✅ Perfect for local/private networks

Examples:
  # Deploy all active agents
  node scripts/deploy-private-agents.js --all

  # Deploy specific agent with custom polling
  node scripts/deploy-private-agents.js --agent-id abc123 --poll-interval 3
        `);
        process.exit(0);
    }
  }

  return options;
}

async function pollLoop(agentIds: string[], intervalSeconds: number) {
  console.log(`\n🔄 Starting polling loop (${intervalSeconds}s interval)...\n`);
  
  let iteration = 0;
  
  while (true) {
    iteration++;
    const timestamp = new Date().toISOString();
    
    for (const agentId of agentIds) {
      try {
        const tasks = await pollGatewayTasks(agentId);
        
        if (tasks.length > 0) {
          console.log(`[${timestamp}] Agent ${agentId}: Processing ${tasks.length} task(s)`);
          
          for (const task of tasks) {
            try {
              const response = await invokeAIPAgent(agentId, task.context);
              await submitTaskResult(task.task_id, response);
              console.log(`  ✅ Task ${task.task_id} completed`);
            } catch (error) {
              console.error(`  ❌ Task ${task.task_id} failed:`, error instanceof Error ? error.message : error);
            }
          }
        } else if (iteration % 12 === 0) {
          // Log heartbeat every 12 iterations (1 minute if 5s interval)
          console.log(`[${timestamp}] Agent ${agentId}: No tasks (heartbeat)`);
        }
      } catch (error) {
        console.error(`[${timestamp}] Agent ${agentId}: Polling error:`, error instanceof Error ? error.message : error);
      }
    }
    
    // Wait for next poll
    await new Promise(resolve => setTimeout(resolve, intervalSeconds * 1000));
  }
}

async function main() {
  console.log('🚀 HyperClaw → Unibase AIP Deployment (PRIVATE Mode)\n');

  // Parse arguments
  const options = parseArgs();

  // Validate environment
  const requiredEnv = ['AIP_ENDPOINT', 'GATEWAY_URL', 'MEMBASE_ACCOUNT'];
  const missing = requiredEnv.filter(key => !process.env[key]);
  
  if (missing.length > 0) {
    console.error('❌ Missing required environment variables:', missing.join(', '));
    process.exit(1);
  }

  if (!options.agentId && !options.all) {
    console.error('❌ Must specify --agent-id or --all');
    process.exit(1);
  }

  console.log('Environment Configuration:');
  console.log(`  AIP Endpoint:    ${process.env.AIP_ENDPOINT}`);
  console.log(`  Gateway URL:     ${process.env.GATEWAY_URL}`);
  console.log(`  Mode:            POLLING (no public endpoint required)`);
  console.log(`  Wallet:          ${process.env.MEMBASE_ACCOUNT}`);
  console.log(`  Poll Interval:   ${options.pollInterval}s\n`);

  // Health check
  console.log('Step 1: Checking AIP Platform Health...');
  const health = await checkAIPHealth();
  if (!health.healthy) {
    console.error('❌ AIP platform is not healthy');
    process.exit(1);
  }
  console.log('✅ AIP platform is healthy\n');

  // Deploy agents
  console.log('Step 2: Registering Agents (POLLING mode)...');
  
  let agentIds: string[] = [];
  
  if (options.all) {
    console.log('Registering all active agents...');
    const results = await registerAllActiveAgents('POLLING');
    
    console.log(`\n✅ Successfully registered ${results.length} agents:\n`);
    results.forEach((r, i) => {
      console.log(`${i + 1}. ${r.config.name}`);
      console.log(`   AIP Agent ID: ${r.aipAgentId}`);
      console.log(`   Handle:       @${r.config.handle}`);
      console.log(`   Mode:         POLLING (gateway polling)`);
      console.log(`   Cost:         $${r.config.cost_model.base_call_fee} per call`);
      console.log(`   Skills:       ${r.config.skills.length} skills`);
      console.log('');
      agentIds.push(r.aipAgentId);
    });
  } else if (options.agentId) {
    const { aipAgentId, config } = await registerAIPAgent(
      options.agentId,
      'POLLING'
    );

    console.log(`\n✅ Successfully registered agent:\n`);
    console.log(`   Name:         ${config.name}`);
    console.log(`   AIP Agent ID: ${aipAgentId}`);
    console.log(`   Handle:       @${config.handle}`);
    console.log(`   Mode:         POLLING (gateway polling)`);
    console.log(`   Cost:         $${config.cost_model.base_call_fee} per call`);
    console.log(`   Skills:       ${config.skills.map(s => s.name).join(', ')}`);
    console.log('');
    agentIds.push(aipAgentId);
  }

  console.log('✅ Registration complete!\n');
  console.log('Benefits of POLLING mode:');
  console.log('  ✅ No public endpoint required');
  console.log('  ✅ Works behind firewall/NAT');
  console.log('  ✅ Enhanced security (no inbound connections)');
  console.log('  ✅ Perfect for local/private networks\n');
  
  // Start polling loop
  await pollLoop(agentIds, options.pollInterval);
}

main().catch(error => {
  console.error('\n❌ Deployment failed:', error);
  process.exit(1);
});
