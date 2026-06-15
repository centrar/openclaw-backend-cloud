const fs = require('fs');

const CONFIG_PATH = 'C:/Users/arvin/.openclaw/agents.json';
const BACKUP_PATH = 'C:/Users/arvin/.openclaw/agents.json.bak';

// 1. Create a backup first
fs.copyFileSync(CONFIG_PATH, BACKUP_PATH);
console.log(`Backup created at: ${BACKUP_PATH}`);

// 2. Read the config
const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));

// 3. Define the cutting-edge routing topology (Zero-Collision)
const updates = {
  // The Physical Actor
  'uba_god_mode': ['uba_execution', 'dom_interaction', 'UBA_Browser_Task'], 
  
  // The Brain / Orchestrator
  'browser_ops_agent': ['web_workflow', 'browser_e2e', 'web_qa'],
  
  // The Visual Microservice
  'image_analyzer': ['vision_review', 'media_inspection', 'image_analysis'],
  
  // The Security Gatekeeper
  'security_bouncer_agent': ['secret_scan', 'threat_triage', 'dependency_advisory', 'security_scan'],
  
  // Fix the GitHub collision
  'master_orchestrator': ['orchestration', 'code_review', 'test'],
  'github_agency': ['github_learning', 'repo_memory', 'github_issue'],
  
  // Fix the stranded campaign tickets
  'campaign_manager': ['campaign', 'campaign_upload']
};

let changesMade = 0;

// 4. Apply the updates
for (const agent of config.list) {
  if (updates[agent.id]) {
    agent.params = agent.params || {};
    const oldTypes = agent.params.ticketTypes ? [...agent.params.ticketTypes] : [];
    agent.params.ticketTypes = updates[agent.id];
    
    console.log(`\nAgent: ${agent.id}`);
    console.log(`  OLD: ${JSON.stringify(oldTypes)}`);
    console.log(`  NEW: ${JSON.stringify(agent.params.ticketTypes)}`);
    changesMade++;
  }
}

// 5. Save the fixed config
fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
console.log(`\nSuccessfully applied cutting-edge routing topology. Updated ${changesMade} agents.`);
