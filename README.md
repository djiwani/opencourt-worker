# opencourt-worker

SQS consumer worker for [OpenCourt](https://opencourt.fourallthedogs.com). Runs as a containerized ECS Fargate service, continuously polling for checkin/checkout events and processing real-time analytics.

---

## What It Does

1. Long-polls SQS for checkin and checkout events published by the API
2. Recalculates user stats (courts visited, total hours, streaks, total checkins)
3. Checks all badge criteria and awards any newly earned badges
4. Publishes SNS notifications for newly earned badges
5. Rebuilds leaderboard rankings across all categories
6. Deletes the message from SQS on success — failed messages retry up to 5 times then go to the DLQ

---

## Project Structure

```
opencourt-worker/
├── src/
│   ├── worker.js       # SQS long polling loop, graceful shutdown
│   ├── analytics.js    # updateUserStats, awardBadges, updateLeaderboard
│   └── db.js           # pg Pool, lazy initialization
├── Dockerfile
└── .github/workflows/
    └── deploy.yml      # Build → ECR push → ECS redeploy
```

---

## Badges

| Badge | Criteria | Threshold |
|---|---|---|
| 🎾 First Serve | Total check-ins | 1 |
| 🗺️ Court Explorer | Unique courts visited | 5 |
| 🏆 Court Collector | Unique courts visited | 10 |
| 🌆 City Wide | Unique courts visited | 25 |
| 🔥 Hot Streak | Consecutive days | 7 |
| ⚡ Unstoppable | Consecutive days | 30 |
| ⏱️ Hour Player | Total hours on court | 10 |
| 🎖️ Court Veteran | Total hours on court | 100 |
| 🏀 All Court Player | Different sports played | 3 |
| 💯 Century Club | Total check-ins | 100 |

---

## Environment Variables

| Variable | Description |
|---|---|
| `SQS_QUEUE_URL` | Checkin events queue URL |
| `DB_SECRET_ARN` | Secrets Manager ARN for Aurora credentials |
| `USER_NOTIFICATIONS_TOPIC_ARN` | SNS topic for badge notifications |
| `AWS_REGION` | us-east-1 |

---

## CI/CD

Push to `main` → GitHub Actions builds Docker image → pushes to ECR with both `sha` and `latest` tags → force redeploys ECS service and waits for stability.

---

## Checking Worker Health

```bash
# Are tasks running?
aws ecs describe-services --cluster opencourt-cluster --services opencourt-worker --profile dev --query "services[0].{Running:runningCount,Desired:desiredCount}"

# Watch logs live
aws logs tail /ecs/opencourt-worker --since 5m --profile dev --follow

# Start worker if desired count is 0
aws ecs update-service --cluster opencourt-cluster --service opencourt-worker --desired-count 1 --profile dev
```

---

## Critical Gotchas

**Force new deployment doesn't always pick up new images** — If the task definition revision doesn't change, `--force-new-deployment` keeps running the old image. To force a new image, register a new task definition revision first using a stripped-down JSON (exclude read-only fields: `taskDefinitionArn`, `revision`, `status`, `requiresAttributes`, `compatibilities`, `registeredAt`, `registeredBy`). Use `--Encoding ascii` in PowerShell when saving JSON for the AWS CLI.

**Messages retry on failure** — If processing throws an error, the message is NOT deleted. It becomes visible again after the visibility timeout and retries up to 5 times before landing in the DLQ.

**Worker desired count** — The worker service may have `desired_count = 0` after a rebuild. Always verify it's running after deployment.
