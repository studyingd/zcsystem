from dotenv import load_dotenv
load_dotenv()
import os, mysql.connector
conn = mysql.connector.connect(
    host=os.environ['DB_HOST'],
    user=os.environ['DB_USER'],
    password=os.environ['DB_PASSWORD'],
    database=os.environ['DB_NAME'],
    charset='utf8mb4'
)
cur = conn.cursor(dictionary=True)
cur.execute("SELECT id, number, department, site, type, DATE_FORMAT(datetime, '%%Y-%%m-%%d') as dt, status, tag, notice FROM inventory WHERE type LIKE '%%显示器%%' AND datetime BETWEEN '2026-01-01' AND '2026-01-31' ORDER BY datetime")
rows = cur.fetchall()
for r in rows:
    print(r)
print("--- total:", len(rows), "---")
conn.close()
