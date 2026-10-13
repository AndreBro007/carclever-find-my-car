import json,subprocess,random,concurrent.futures as cf,hashlib,re
U="https://carclever-db-test.getcarwise.app/mcp"
def search(args):
    body=json.dumps({"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"find_matching_vehicle","arguments":args}})
    out=subprocess.run(["curl","-s","-m","60","-X","POST",U,"-H","Content-Type: application/json","-H","Accept: application/json, text/event-stream","-d",body],capture_output=True,text=True).stdout
    for l in out.split("\n"):
        if l.startswith("data:"):
            try: return json.loads(l[5:])["result"]["structuredContent"]["results"]
            except Exception: return []
    return []
makes=[("Toyota","Camry"),("Toyota","RAV4"),("Toyota","Prius"),("Toyota","Highlander"),("Honda","Accord"),("Honda","Civic"),("Honda","CR-V"),("Ford","F-150"),("Ford","Escape"),("Ford","Explorer"),("Chevrolet","Silverado 1500"),("Chevrolet","Equinox"),("Nissan","Rogue"),("Hyundai","Tucson"),("Hyundai","Ioniq 5"),("Kia","Telluride"),("Kia","Sportage"),("Jeep","Grand Cherokee"),("Subaru","Outback"),("Mazda","CX-5"),("BMW","X5"),("Tesla","Model Y"),("Tesla","Model 3"),("Lexus","RX"),("Volkswagen","Tiguan"),("Acura","MDX"),("Ram","1500"),("GMC","Sierra 1500")]
zips=["90210","10001","60601","75201","33101","98101"]
jobs=[(m,z) for m in makes for z in zips]; random.seed(3); random.shuffle(jobs)
rows={}
def job(j):
    (mk,md),z=j; return search({"make":mk,"model":md,"zip":z,"radiusMiles":120,"yearMin":2012})
with cf.ThreadPoolExecutor(8) as ex:
    for r in ex.map(job,jobs[:90]):
        for c in r:
            v=c["identity"]["vin"]
            if v not in rows: rows[v]=c
print("listings collected:",len(rows))
cols=["id","title","condition","description","price","image_link","link","availability","identifier_exists","dealer_id","dealer_name","dealer_street","dealer_city","dealer_state","dealer_zip","dealer_radius","vehicle_vin","vehicle_stock_number","vehicle_year","vehicle_make","vehicle_model","vehicle_series","vehicle_odometer","vehicle_body","vehicle_door_number","vehicle_exterior_color","vehicle_interior_color"]
clean=lambda x: re.sub(r"[\t\r\n]"," ",str(x if x is not None else ""))
out=["\t".join(cols)]
for v,c in rows.items():
    i,l,m,d,lk,b=c["identity"],c["listing"],c["media"],c["detail"],c["links"],c["body"]
    out.append("\t".join(clean(x) for x in [hashlib.md5(v.encode()).hexdigest(),f'{i["year"]} {i["make"]} {i["model"]} {i.get("trim") or ""}',c["condition"]["inventoryType"],"",l["price"],m.get("primaryImage") or "",lk.get("affiliateUrl") or "","InStock","yes",l.get("dealerId") or "",l.get("dealer") or "","",l.get("city") or "",l.get("state") or "",l.get("zip") or "","",v,"",i["year"],i["make"],i["model"],i.get("trim") or "",l.get("mileage") if l.get("mileage") is not None else "",b.get("bodyStyle") or "",b.get("doors") or "",d.get("exteriorColor") or "",d.get("interiorColor") or ""]))
open("/tmp/e2e_feed.tsv","w").write("\n".join(out)+"\n"); print("feed rows written:",len(out)-1)
