# Inbox Task 1 immutable pins

No source/test bytes changed during the documentation split. Counts are inventory checks, not full semantic coverage. See [ownership](inbox-ownership.md) and [evidence](inbox-evidence.md).

## Contract inputs

Core/delivery/helper files are under `/home/shinelay/architecture-dept/tests/role-priority-inbox/`.

| Input | Count | SHA256 |
|---|---:|---|
| role-priority-inbox.cases.json | 90 | a93ee55478be95282bca124e31400e419035fe016e497995b828585e2242d7b1 |
| delivery/delivery.cases.json | 69 | 1aabea2f3198645e613beb47d66053e3085640a15003e71a62c28df037bdd059 |
| helpers/helper.cases.json | 120 | aabc75c5342fe85d6a3efefebb0ebd3546b9ed54ca78c95b3e6e5eec66fab81b |
| #602 manifest | — | c8d277d114937642d116f8967852e7a53be66f08e934351774714de102fb004b |
| #607 boundary cases | — | f9e68ff62ee5189055c865779fe0ee6dd63ab842b8714835dbcdbd30e19df0a1 |
| RET-4 migration administration | — | 751f1416ffbcec7b1cd9e6e37b351f2d283e648e76a73432b230567c8c3ef0e0 |
| Queue pure requester vectors, commit 427c089 | 32 | 69100f10ba641e89da39edc7cd6e189f8b182e791062e562cfd770bf0c18430a |

Canonical queue vector source: `/home/shinelay/projects/pi-queue/tests/inbox-requester-vectors.ts`.

## Assertion and seam files

Test filenames below are relative to this document's directory. Production filenames are relative to the repository root.

| File | SHA256 |
|---|---|
| inbox-boundary.test.ts | 42e19dce2de91f04c98d59c4fdd87e773072f93180ce885f72a07fe93ddbfa7b |
| inbox-helper.test.ts | bc4bcc6a094bdfa276b98cdebf1c7ceb32b8fb43a2b1c094bc446309de80d0d7 |
| inbox-ledger.test.ts | cea61906aac8b235bb7f54b50a5f038eff19f1e5d1832dbd507a8d2c6163f93d |
| inbox-retention.test.ts | ff1b5b297379dd97cfb13cc20c270785651e010d920c58c317ec64431ad26e59 |
| inbox-corpora.ts | 678452aa88c50d15f4f5060e6c9397fff3995b5d6d6c23546ed8c218475193ea |
| inbox.config.ts | ac8243eb5841d3a678a6b781b4ed0f4af917b0247b2ce93496d271e4c9192443 |
| inbox-repo-roots.ts | f9bfd9f428683d1add90ff43c4384af43c3f9fd5ad7ab93209ef93ad4ea85dda |
| inbox-queue-fixture.ts | c7d663278695c35810192178ac6d384128163104b261c8e83ae85d9de9acadbf |
| inbox-world.ts | 76f92b4554bdd60d51502545f965f66c7126480e249862b937bb262ffdf0d532 |
| inbox-alarm.test.ts | 80bc96eec77d4f206f3d74f885282940e4b71f01b35fe6de15042f5958086882 |
| inbox-host.test.ts | e05158d86efec683ad2317233a51eaa304c8caec8362dfcf31a005b444a67d7c |
| inbox-migration.test.ts | e9e9ac4ed2c2a5d8eff15e138b2b90822ad721ea2de8d5478cd92ce4ace9cd0f |
| inbox-races.test.ts | 2367b7fa4c083e94948f66a84678ae9153f3e93ade01333474403aa499aa7ae3 |
| inbox-requester.test.ts | d662d76b1812d21b8da7b92b108a65f560591c476a5eaa6e7d74cdd4952c8c00 |
| server/inbox-runtime.ts | 7cdfece34d0e581142210d967e7997c2dd631f67417fa154638023c48c3d9764 |
| server/inbox-helper-host.ts | 93bf93a6b25752429565f5d1a66e6cea57feb9a3c686eab38b2c105feef653c7 |
| server/inbox-migration.ts | 2d514c2fa43ce67c8059630cea055a44698011249d53d67f9f3c48dd6e3c19d6 |
