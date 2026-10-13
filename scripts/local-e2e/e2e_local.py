import json,subprocess,time,collections
U="http://localhost:3100/mcp"
def call(args):
    body=json.dumps({"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"find_matching_vehicle","arguments":args}})
    t=time.time(); out=subprocess.run(["curl","-s","-m","100","-X","POST",U,"-H","Content-Type: application/json","-H","Accept: application/json, text/event-stream","-d",body],capture_output=True,text=True).stdout
    for l in out.split("\n"):
        if l.startswith("data:"): return time.time()-t,json.loads(l[5:])
    return time.time()-t,{"raw":out[:300]}
tests=[("RAV4 near 90210",{"make":"Toyota","model":"RAV4","zip":"90210","radiusMiles":150}),("Used SUV AWD near 10001",{"bodyType":"SUV","drivetrain":"AWD","zip":"10001","radiusMiles":150}),("Honda CR-V near 60601",{"make":"Honda","model":"CR-V","zip":"60601","radiusMiles":200}),("Tesla Model Y near 33101",{"make":"Tesla","model":"Model Y","zip":"33101","radiusMiles":300}),("Hybrid required: Toyota near 90210",{"make":"Toyota","zip":"90210","radiusMiles":150,"electrificationTypes":["hybrid"],"electrificationRequirement":"required"}),("Silverado near 75201",{"make":"Chevrolet","model":"Silverado 1500","zip":"75201","radiusMiles":300})]
stats=collections.Counter(); n=0
for name,args in tests:
    dt,r=call(args)
    if "error" in r: print(f"## {name}: ERROR",json.dumps(r["error"])[:300]); continue
    res=r["result"]
    if res.get("isError"): print(f"## {name}: isError", res["content"][0]["text"][:300]); continue
    sc=res["structuredContent"]; m=sc["meta"]
    print(f"## {name}: {dt:.1f}s | shown {m['resultsShown']} | considered {m['totalCandidatesConsidered']} | serviceError {m['serviceError']}")
    for c in sc["results"]:
        n+=1; d=c["detail"]; p=c["powertrain"]; i=c["identity"]
        for k,v in (("drivetrain",p.get("drivetrain")),("engine",p.get("engine")),("transmission",p.get("transmission")),("cylinders",d.get("cylinders")),("seats",d.get("seats")),("safetyTech",d.get("standardSafetyTech")),("rating",d.get("nhtsaOverallRating")),("recallNote",d.get("nhtsaRecallNote")),("fuelDisplay",d.get("fuelTypeDisplay"))):
            if v: stats[k]+=1
        if sc["results"].index(c)<2: print("   ",i["year"],i["make"],i["model"],"|",p.get("drivetrain"),"|",p.get("engine"),"|",p.get("transmission"),"| seats",d.get("seats"),"| rating",d.get("nhtsaOverallRating"),"| recall:",(d.get("nhtsaRecallNote") or "-")[:46],"| tech",len(d.get("standardSafetyTech") or []),"| fuel",d.get("fuelTypeDisplay"))
print("\nfields populated across",n,"shown cars:",dict(stats))
