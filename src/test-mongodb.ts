import { MongoClient } from "mongodb";

const uri = process.env.MONGODB_URI;

if (!uri) {
  throw new Error("MONGODB_URI is missing");
}

const client = new MongoClient(uri);

try {
  await client.connect();

  await client.db("admin").command({
    ping: 1,
  });

  console.log("MongoDB Atlas connected ✅");

  const db = client.db("nene");

  console.log(
    `Database selected: ${db.databaseName}`
  );
} finally {
  await client.close();
}
