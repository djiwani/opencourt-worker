const { query } = require('./db');
const { SNSClient, PublishCommand } = require('@aws-sdk/client-sns');

const snsClient = new SNSClient({ region: process.env.AWS_REGION || 'us-east-1' });

// ── UPDATE USER STATS ─────────────────────────────────────────────────────────
// Recalculates stats for a single user after a checkin or checkout event

async function updateUserStats(userId) {
  const stats = await query(`
    SELECT
      COUNT(DISTINCT court_id)            AS courts_visited,
      COUNT(*)                            AS total_checkins,
      COALESCE(SUM(duration_mins), 0)    AS total_mins,
      MAX(checked_in_at)                  AS last_checkin
    FROM checkins
    WHERE user_id = $1
  `, [userId]);

  const { courts_visited, total_checkins, total_mins } = stats.rows[0];

  // Calculate current streak (consecutive days with checkins)
  const streakResult = await query(`
    WITH daily_checkins AS (
      SELECT DISTINCT DATE(checked_in_at) AS checkin_date
      FROM checkins
      WHERE user_id = $1
      ORDER BY checkin_date DESC
    ),
    numbered AS (
      SELECT
        checkin_date,
        ROW_NUMBER() OVER (ORDER BY checkin_date DESC) AS rn
      FROM daily_checkins
    ),
    streak_groups AS (
      SELECT
        checkin_date,
        checkin_date - (rn || ' days')::interval AS grp
      FROM numbered
    )
    SELECT COUNT(*) AS streak
    FROM streak_groups
    WHERE grp = (SELECT grp FROM streak_groups ORDER BY checkin_date DESC LIMIT 1)
  `, [userId]);

  const current_streak = parseInt(streakResult.rows[0]?.streak || 0);

  await query(`
    INSERT INTO user_stats (
      user_id, courts_visited, total_checkins,
      total_hours, current_streak, updated_at
    ) VALUES ($1, $2, $3, $4, $5, NOW())
    ON CONFLICT (user_id) DO UPDATE SET
      courts_visited = EXCLUDED.courts_visited,
      total_checkins = EXCLUDED.total_checkins,
      total_hours    = EXCLUDED.total_hours,
      current_streak = EXCLUDED.current_streak,
      updated_at     = NOW()
  `, [
    userId,
    parseInt(courts_visited),
    parseInt(total_checkins),
    parseFloat(total_mins) / 60,
    current_streak
  ]);

  console.log(`Stats updated for user ${userId}: ${courts_visited} courts, ${total_checkins} checkins, ${current_streak} day streak`);

  return { courts_visited: parseInt(courts_visited), total_checkins: parseInt(total_checkins), total_hours: parseFloat(total_mins) / 60, current_streak };
}

// ── AWARD BADGES ──────────────────────────────────────────────────────────────
// Checks all badge criteria for a single user and awards any newly earned badges

async function awardBadges(userId, stats) {
  const badges = await query('SELECT * FROM badges');
  const newBadges = [];

  for (const badge of badges.rows) {
    // Check if user already has this badge
    const existing = await query(`
      SELECT 1 FROM user_badges
      WHERE user_id = $1 AND badge_id = $2
    `, [userId, badge.badge_id]);

    if (existing.rows.length > 0) continue;

    // Check if user meets criteria
    let earned = false;
    const value = parseFloat(badge.criteria_value);

    switch (badge.criteria_type) {
      case 'courts_visited':
        earned = stats.courts_visited >= value;
        break;
      case 'total_checkins':
        earned = stats.total_checkins >= value;
        break;
      case 'total_hours':
        earned = stats.total_hours >= value;
        break;
      case 'streak_days':
        earned = stats.current_streak >= value;
        break;
    }

    if (earned) {
      await query(`
        INSERT INTO user_badges (user_id, badge_id, earned_at)
        VALUES ($1, $2, NOW())
        ON CONFLICT DO NOTHING
      `, [userId, badge.badge_id]);

      newBadges.push(badge);
      console.log(`Badge "${badge.name}" awarded to user ${userId}`);
    }
  }

  return newBadges;
}

// ── UPDATE LEADERBOARD ────────────────────────────────────────────────────────
// Rebuilds leaderboard rankings for all users after a stats change

async function updateLeaderboard() {
  const categories = [
    { name: 'courts_visited', column: 'courts_visited' },
    { name: 'total_checkins', column: 'total_checkins' },
    { name: 'total_hours',    column: 'total_hours' },
    { name: 'streak_days',    column: 'current_streak' },
  ];

  for (const category of categories) {
    await query(`
      DELETE FROM leaderboard
      WHERE period = 'all_time' AND category = $1
    `, [category.name]);

    await query(`
      INSERT INTO leaderboard (user_id, category, period, score, rank, updated_at)
      SELECT
        user_id,
        $1,
        'all_time',
        ${category.column}::numeric,
        RANK() OVER (ORDER BY ${category.column} DESC),
        NOW()
      FROM user_stats
      WHERE ${category.column} > 0
    `, [category.name]);
  }

  console.log('Leaderboard updated');
}

// ── NOTIFY NEW BADGES ─────────────────────────────────────────────────────────

async function notifyNewBadges(userId, newBadges) {
  if (!newBadges.length || !process.env.USER_NOTIFICATIONS_TOPIC_ARN) return;

  const userResult = await query(
    'SELECT email FROM users WHERE user_id = $1',
    [userId]
  );

  if (!userResult.rows.length) return;

  for (const badge of newBadges) {
    try {
      await snsClient.send(new PublishCommand({
        TopicArn: process.env.USER_NOTIFICATIONS_TOPIC_ARN,
        Subject: `You earned the ${badge.name} badge! 🏆`,
        Message: `Congratulations! You just earned the "${badge.name}" badge on OpenCourt.\n\n${badge.description}\n\nKeep playing!`,
        MessageAttributes: {
          user_id: {
            DataType: 'String',
            StringValue: userId
          }
        }
      }));
      console.log(`Badge notification sent to user ${userId} for badge "${badge.name}"`);
    } catch (err) {
      console.error(`Failed to notify user ${userId}:`, err.message);
    }
  }
}

// ── PROCESS EVENT ─────────────────────────────────────────────────────────────
// Main entry point — called for each SQS message

async function processCheckinEvent(event) {
  const { user_id, event_type } = event;

  if (!user_id) {
    throw new Error('Missing user_id in event');
  }

  console.log(`Processing ${event_type} event for user ${user_id}`);

  // Update stats
  const stats = await updateUserStats(user_id);

  // Check and award badges
  const newBadges = await awardBadges(user_id, stats);

  // Update leaderboard
  await updateLeaderboard();

  // Send badge notifications
  await notifyNewBadges(user_id, newBadges);

  console.log(`Event processed for user ${user_id}`);
}

module.exports = { processCheckinEvent };
