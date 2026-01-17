const admin = require("firebase-admin");
const fs = require("fs");

// Initialize Firebase Admin SDK
admin.initializeApp({ projectId: "real-karma-league" });
const db = admin.firestore();

async function exportTodaysPlayers() {
  // Query live_games collection
  const snapshot = await db.collection("live_games").get();

  console.log(`Found ${snapshot.docs.length} documents in live_games`);

  // Extract players from all games
  const players = new Map(); // Use Map to dedupe by player_id

  snapshot.docs.forEach(doc => {
    const data = doc.data();
    // Extract from team1_lineup and team2_lineup arrays
    const allPlayers = [...(data.team1_lineup || []), ...(data.team2_lineup || [])];

    allPlayers.forEach(player => {
      if (player.player_id && player.player_handle) {
        players.set(player.player_id, player.player_handle);
      }
    });
  });

  // Write CSV
  const csvLines = ["player_handle,player_id"];
  players.forEach((handle, id) => {
    csvLines.push(`${handle},${id}`);
  });

  const outputPath = "todays_players.csv";
  fs.writeFileSync(outputPath, csvLines.join("\n"));
  console.log(`Exported ${players.size} unique players to ${outputPath}`);
}

exportTodaysPlayers()
  .then(() => process.exit(0))
  .catch(err => {
    console.error("Error:", err);
    process.exit(1);
  });
