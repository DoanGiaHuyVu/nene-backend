import {
  MongoClient,
  type Db,
} from "mongodb";

const uri =
  process.env.MONGODB_URI;

if (!uri) {
  throw new Error(
    "MONGODB_URI is missing"
  );
}

const client =
  new MongoClient(uri);

let db: Db | null = null;

export interface StoredTask {
  id: string;
  prompt: string;

  sourceTaskId?: string;
  
  status: string;
  progress: string;

  writeCount: number;

  createdAt: string;
  updatedAt: string;

  containerName: string;
  volumeName: string;

  artifactPath?: string;
  
  github?: {
    branch: string;
    url: string;
    commit: string;
  };

  deployment?: {
    provider: "render";
    status:
      | "creating"
      | "building"
      | "live"
      | "failed";
    serviceId?: string;
    deployId?: string;
    url?: string;
    dashboardUrl?: string;
    error?: string;
  };

  error?: string;
}

export interface StoredEvent {
  taskId: string;

  seq: number;
  timestamp: string;

  type: string;
  data: unknown;
}

export async function connectDatabase() {
  await client.connect();

  db = client.db("nene");

  /*
   * One task document per ne-ne task.
   */
  await db
    .collection<StoredTask>("tasks")
    .createIndex(
      { id: 1 },
      { unique: true }
    );

  /*
   * Prevent duplicate task events.
   */
  await db
    .collection<StoredEvent>("events")
    .createIndex(
      {
        taskId: 1,
        seq: 1,
      },
      {
        unique: true,
      }
    );

  console.log(
    "MongoDB Atlas connected ✅"
  );

  return db;
}

function getDatabase() {
  if (!db) {
    throw new Error(
      "MongoDB has not been connected"
    );
  }

  return db;
}

export async function saveTask(
  task: StoredTask
) {
  const database =
    getDatabase();

  await database
    .collection<StoredTask>("tasks")
    .updateOne(
      {
        id: task.id,
      },
      {
        $set: task,
      },
      {
        upsert: true,
      }
    );
}

export async function saveEvent(
  event: StoredEvent
) {
  const database =
    getDatabase();

  await database
    .collection<StoredEvent>("events")
    .updateOne(
      {
        taskId: event.taskId,
        seq: event.seq,
      },
      {
        $setOnInsert: event,
      },
      {
        upsert: true,
      }
    );
}

export async function findTask(
  id: string
) {
  return getDatabase()
    .collection<StoredTask>("tasks")
    .findOne(
      { id },
      {
        projection: {
          _id: 0,
        },
      }
    );
}

export async function findEvents(
  taskId: string
) {
  return getDatabase()
    .collection<StoredEvent>("events")
    .find(
      { taskId },
      {
        projection: {
          _id: 0,
        },
      }
    )
    .sort({
      seq: 1,
    })
    .toArray();
}
