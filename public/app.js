const $ = id => document.getElementById(id);

async function refresh(){
  try{
    const r=await fetch("/health",{cache:"no-store"});
    const d=await r.json();

    const connected=!!d.agentConnected;
    $("gateway").textContent="Online";
    $("gateway").className="value good";
    $("gatewayMeta").textContent=location.host;

    $("agent").textContent=connected?"Connected":"Offline";
    $("agent").className="value "+(connected?"good":"bad");
    $("agentMeta").textContent=connected?"Termux is ready":"Start the Termux agent";

    $("pending").textContent=d.pendingRequests ?? 0;
    $("overall").textContent=connected?"● All systems ready":"● Waiting for Termux";
    $("overall").className="pill "+(connected?"good":"bad");

    const base=location.origin;
    $("mcpUrl").textContent=base+"/mcp";
    $("healthUrl").textContent=base+"/health";
    $("agentUrl").textContent="wss://"+location.host+"/agent";

    $("json").textContent=JSON.stringify(d,null,2);
    $("updated").textContent="Updated "+new Date().toLocaleTimeString();
  }catch(e){
    $("gateway").textContent="Error";
    $("gateway").className="value bad";
    $("overall").textContent="● Gateway unavailable";
    $("overall").className="pill bad";
    $("json").textContent=String(e);
  }
}
function copyText(t){
  navigator.clipboard?.writeText(t);
}
refresh();
setInterval(refresh,5000);
