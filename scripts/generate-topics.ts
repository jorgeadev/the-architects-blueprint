import * as fs from "fs";
import { loadTopics, generateNewTopics } from "./utils";
import { installProcessErrorHandlers } from "./observability";

installProcessErrorHandlers("generation.topics");

async function run() {
    try {
        const { topics, configPath } = await loadTopics();
        // Infinite topic generation
        const amountToGenerate = topics.length < 20 ? 10 : 5;
        const newTopics = await generateNewTopics(amountToGenerate);

        if (newTopics.length > 0) {
            topics.push(...newTopics);
            fs.writeFileSync(configPath, JSON.stringify({ topics }, null, 2), "utf8");
            console.log(
                `Successfully rotated topics. Added ${newTopics.length}. Total topics in pool: ${topics.length}`
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
    }
}

run();
