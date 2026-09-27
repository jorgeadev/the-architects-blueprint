import { generateNewTopics } from "./utils";
import { installProcessErrorHandlers } from "./observability";
import { addTopics, createTopicPool, ensureTopicStore, getTopicCount } from "./topic-store";

installProcessErrorHandlers("generation.topics");

async function run() {
    const pool = createTopicPool();
    try {
        await ensureTopicStore(pool);
        const topicCount = await getTopicCount(pool);
        const amountToGenerate = topicCount < 20 ? 10 : 5;
        const newTopics = await generateNewTopics(amountToGenerate);

        if (newTopics.length > 0) {
            const addedCount = await addTopics(pool, newTopics);
            console.log(
                `Successfully rotated topics. Added ${addedCount}. Total topics in pool: ${await getTopicCount(pool)}`
            );
        } else {
            console.log(
                "Skipping topic rotation because AI failed to generate valid JSON or rate limited."
            );
        }

        console.log("Topic pool replenishment workflow completed.");
    } catch (e) {
        console.error("Failed executing generation pipe", e);
        process.exit(1);
    } finally {
        await pool.end();
    }
}

run();
