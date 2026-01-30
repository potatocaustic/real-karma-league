/**
 * READ-ONLY verification script for RKL-S9.js efficiency optimizations
 * Observes production data to verify assumptions about the refactoring
 */
const admin = require('firebase-admin');
const serviceAccount = require('./serviceAccountKey.json');

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});
const db = admin.firestore();

async function verify() {
  console.log('========================================');
  console.log('RKL-S9.js Optimization Verification');
  console.log('========================================\n');

  const seasonId = 'S9';

  // ========================================
  // 1. Count games in each collection (Major League)
  // ========================================
  console.log('=== Game Counts (S9 Major) ===');
  const [games, postGames, exhibition] = await Promise.all([
    db.collection('seasons').doc(seasonId).collection('games').get(),
    db.collection('seasons').doc(seasonId).collection('post_games').get(),
    db.collection('seasons').doc(seasonId).collection('exhibition_games').get()
  ]);

  const gamesCount = games.docs.filter(d => d.id !== 'placeholder').length;
  const postGamesCount = postGames.docs.filter(d => d.id !== 'placeholder').length;
  const exhibitionCount = exhibition.docs.filter(d => d.id !== 'placeholder').length;
  const totalGames = gamesCount + postGamesCount + exhibitionCount;

  console.log(`  games: ${gamesCount}`);
  console.log(`  post_games: ${postGamesCount}`);
  console.log(`  exhibition_games: ${exhibitionCount}`);
  console.log(`  TOTAL: ${totalGames}`);
  console.log(`\n  >> OLD fetchAllGames() loaded ${totalGames} docs per page load`);
  console.log(`  >> NEW on-demand approach: ~4-53 docs depending on view\n`);

  // ========================================
  // 2. Check Minor League game counts too
  // ========================================
  console.log('=== Game Counts (S9 Minor) ===');
  const [minorGames, minorPostGames, minorExhibition] = await Promise.all([
    db.collection('minor_seasons').doc(seasonId).collection('games').get(),
    db.collection('minor_seasons').doc(seasonId).collection('post_games').get(),
    db.collection('minor_seasons').doc(seasonId).collection('exhibition_games').get()
  ]);

  const minorGamesCount = minorGames.docs.filter(d => d.id !== 'placeholder').length;
  const minorPostGamesCount = minorPostGames.docs.filter(d => d.id !== 'placeholder').length;
  const minorExhibitionCount = minorExhibition.docs.filter(d => d.id !== 'placeholder').length;

  console.log(`  games: ${minorGamesCount}`);
  console.log(`  post_games: ${minorPostGamesCount}`);
  console.log(`  exhibition_games: ${minorExhibitionCount}`);
  console.log(`  TOTAL: ${minorGamesCount + minorPostGamesCount + minorExhibitionCount}\n`);

  // ========================================
  // 3. Verify live_games have collectionName field
  // ========================================
  console.log('=== Live Games - collectionName Field Check ===');
  const liveGames = await db.collection('live_games').get();

  if (liveGames.empty) {
    console.log('  No live games currently active (scoring may be stopped)\n');
  } else {
    let missingCollectionName = 0;
    liveGames.docs.forEach(doc => {
      const data = doc.data();
      if (!data.collectionName) {
        missingCollectionName++;
        console.log(`  WARNING: ${doc.id} - collectionName MISSING (week: ${data.week || 'N/A'})`);
      }
    });
    if (missingCollectionName === 0) {
      console.log(`  All ${liveGames.size} live games have collectionName field`);
    } else {
      console.log(`\n  >> ${missingCollectionName}/${liveGames.size} games missing collectionName`);
      console.log(`  >> Code falls back to 'games' or uses week detection`);
    }
    console.log('');
  }

  // Also check minor live games
  const minorLiveGames = await db.collection('minor_live_games').get();
  if (!minorLiveGames.empty) {
    console.log(`  Minor live games: ${minorLiveGames.size}`);
  }

  // ========================================
  // 4. Test Finals query (the new optimized query)
  // ========================================
  console.log('\n=== Finals Query Test ===');
  const finalsQuery = await db.collection('seasons')
    .doc(seasonId)
    .collection('post_games')
    .where('series_id', '==', 'Finals')
    .limit(1)
    .get();

  console.log(`  Query: where('series_id', '==', 'Finals'), limit(1)`);
  console.log(`  Result: ${!finalsQuery.empty ? 'Found' : 'Not found'}`);
  if (!finalsQuery.empty) {
    const finals = finalsQuery.docs[0].data();
    console.log(`  series_winner: ${finals.series_winner || 'NOT SET (season in progress)'}`);
    console.log(`  completed: ${finals.completed}`);
  }

  // ========================================
  // 5. Test incomplete postseason query
  // ========================================
  console.log('\n=== Incomplete Postseason Games Query Test ===');
  const incompleteQuery = await db.collection('seasons')
    .doc(seasonId)
    .collection('post_games')
    .where('completed', '!=', 'TRUE')
    .get();

  console.log(`  Query: where('completed', '!=', 'TRUE')`);
  console.log(`  Result: ${incompleteQuery.size} incomplete postseason games`);

  if (incompleteQuery.size > 0) {
    const teamIds = new Set();
    incompleteQuery.forEach(doc => {
      const game = doc.data();
      if (game.team1_id && game.team1_id !== 'TBD') teamIds.add(game.team1_id);
      if (game.team2_id && game.team2_id !== 'TBD') teamIds.add(game.team2_id);
    });
    console.log(`  Unique teams remaining: ${teamIds.size}`);
  }

  // ========================================
  // 6. Check live_scoring_status
  // ========================================
  console.log('\n=== Live Scoring Status ===');
  const statusDoc = await db.collection('live_scoring_status').doc('current').get();
  if (statusDoc.exists) {
    const status = statusDoc.data();
    console.log(`  status: ${status.status}`);
    console.log(`  activeGameDate: ${status.activeGameDate || 'N/A'}`);
  } else {
    console.log('  Status document not found');
  }

  // ========================================
  // 7. Recent games simulation
  // ========================================
  console.log('\n=== Recent Games Query Simulation ===');
  console.log('  (What loadRecentGames would fetch)\n');

  const recentGamesQuery = await db.collection('seasons')
    .doc(seasonId)
    .collection('games')
    .where('completed', '==', 'TRUE')
    .orderBy('date', 'desc')
    .limit(15)
    .get();

  const recentPostQuery = await db.collection('seasons')
    .doc(seasonId)
    .collection('post_games')
    .where('completed', '==', 'TRUE')
    .orderBy('date', 'desc')
    .limit(15)
    .get();

  console.log(`  games (limit 15): ${recentGamesQuery.size} docs`);
  console.log(`  post_games (limit 15): ${recentPostQuery.size} docs`);
  console.log(`  >> Total for recent view: ~${recentGamesQuery.size + recentPostQuery.size} docs`);

  // ========================================
  // Summary
  // ========================================
  console.log('\n========================================');
  console.log('VERIFICATION SUMMARY');
  console.log('========================================');
  console.log(`\n  Old approach: ${totalGames} docs loaded per page view`);
  console.log(`  New approach: ~${recentGamesQuery.size + recentPostQuery.size} docs (stopped) or ~4 docs (live)`);
  console.log(`  Estimated savings: ${Math.round((1 - (recentGamesQuery.size + recentPostQuery.size) / totalGames) * 100)}% - 98%`);
  console.log('\n  All queries executed successfully - no index errors');
  console.log('========================================\n');

  process.exit(0);
}

verify().catch(err => {
  console.error('Verification failed:', err);
  process.exit(1);
});
