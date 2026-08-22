import type { Database } from "bun:sqlite";
import { dbRun } from "../db/write.ts";
import { isAutomatedSenderEmail } from "./automated-sender.ts";
import { NIMBUS_PERSON_NAMESPACE_UUID, uuidV5 } from "./person-id.ts";
import {
  deletePersonById,
  findPersonByBitbucketUuid,
  findPersonByCanonicalEmail,
  findPersonByDiscordUserId,
  findPersonByGithubLogin,
  findPersonByGitlabLogin,
  findPersonByJiraAccountId,
  findPersonByLinearMemberId,
  findPersonByMicrosoftUserId,
  findPersonByNotionUserId,
  findPersonBySlackHandle,
  getPersonById,
  insertPerson,
  normalizeEmail,
  updatePersonHandles,
} from "./person-store.ts";
import type { PersonRecord, PersonSyncHints } from "./person-types.ts";

function nonEmpty(s: string | undefined): s is string {
  return s !== undefined && s.trim() !== "";
}

export function resolvePersonForSync(db: Database, hints: PersonSyncHints): string | null {
  if (
    !nonEmpty(hints.canonicalEmail) &&
    !nonEmpty(hints.githubLogin) &&
    !nonEmpty(hints.gitlabLogin) &&
    !nonEmpty(hints.slackHandle) &&
    !nonEmpty(hints.linearMemberId) &&
    !nonEmpty(hints.jiraAccountId) &&
    !nonEmpty(hints.notionUserId) &&
    !nonEmpty(hints.bitbucketUuid) &&
    !nonEmpty(hints.microsoftUserId) &&
    !nonEmpty(hints.discordUserId)
  ) {
    return null;
  }

  // A send-only mailbox is not a person (F7). `nimbus people list` filled with `newsletter@`,
  // `jobalerts-noreply@` and friends because every gmail `From:` became a graph entity — which
  // dilutes `nimbus expert` and the involvement weighting F3 depends on.
  //
  // Only when email is the ONLY identity on offer. A hint carrying a GitHub login or a Slack
  // handle alongside the address is a real account that happens to send from a no-reply address,
  // and dropping it would lose a genuine collaborator.
  if (
    isAutomatedSenderEmail(hints.canonicalEmail) &&
    !nonEmpty(hints.githubLogin) &&
    !nonEmpty(hints.gitlabLogin) &&
    !nonEmpty(hints.slackHandle) &&
    !nonEmpty(hints.linearMemberId) &&
    !nonEmpty(hints.jiraAccountId) &&
    !nonEmpty(hints.notionUserId) &&
    !nonEmpty(hints.bitbucketUuid) &&
    !nonEmpty(hints.microsoftUserId) &&
    !nonEmpty(hints.discordUserId)
  ) {
    return null;
  }

  const email = nonEmpty(hints.canonicalEmail) ? normalizeEmail(hints.canonicalEmail) : undefined;

  if (email !== undefined) {
    const byEmail = findPersonByCanonicalEmail(db, email);
    if (byEmail !== null) {
      mergeHintsIntoPerson(db, byEmail.id, hints, { forceLinked: true });
      return byEmail.id;
    }
    const handleMatch = findExistingPersonByHandles(db, hints);
    if (handleMatch !== null) {
      updatePersonHandles(db, handleMatch.id, {
        canonicalEmail: email,
        displayName: hints.displayName ?? handleMatch.displayName,
        githubLogin: hints.githubLogin ?? handleMatch.githubLogin,
        gitlabLogin: hints.gitlabLogin ?? handleMatch.gitlabLogin,
        slackHandle: hints.slackHandle ?? handleMatch.slackHandle,
        linearMemberId: hints.linearMemberId ?? handleMatch.linearMemberId,
        jiraAccountId: hints.jiraAccountId ?? handleMatch.jiraAccountId,
        notionUserId: hints.notionUserId ?? handleMatch.notionUserId,
        bitbucketUuid: hints.bitbucketUuid ?? handleMatch.bitbucketUuid,
        microsoftUserId: hints.microsoftUserId ?? handleMatch.microsoftUserId,
        discordUserId: hints.discordUserId ?? handleMatch.discordUserId,
        linked: true,
      });
      return handleMatch.id;
    }
    const id = uuidV5(`email:${email}`, NIMBUS_PERSON_NAMESPACE_UUID);
    insertPerson(db, {
      id,
      displayName: hints.displayName ?? null,
      canonicalEmail: email,
      githubLogin: hints.githubLogin ?? null,
      gitlabLogin: hints.gitlabLogin ?? null,
      slackHandle: hints.slackHandle ?? null,
      linearMemberId: hints.linearMemberId ?? null,
      jiraAccountId: hints.jiraAccountId ?? null,
      notionUserId: hints.notionUserId ?? null,
      bitbucketUuid: hints.bitbucketUuid ?? null,
      microsoftUserId: hints.microsoftUserId ?? null,
      discordUserId: hints.discordUserId ?? null,
      linked: true,
      metadata: {},
    });
    return id;
  }

  return resolveHandleOnlyPerson(db, hints);
}

type HandleLookup = {
  value: (h: PersonSyncHints) => string | undefined;
  find: (db: Database, v: string) => PersonRecord | null;
};

const HANDLE_LOOKUPS: readonly HandleLookup[] = [
  {
    value: (h) => (nonEmpty(h.githubLogin) ? h.githubLogin.trim() : undefined),
    find: findPersonByGithubLogin,
  },
  {
    value: (h) => (nonEmpty(h.gitlabLogin) ? h.gitlabLogin.trim() : undefined),
    find: findPersonByGitlabLogin,
  },
  {
    value: (h) => (nonEmpty(h.slackHandle) ? h.slackHandle.trim() : undefined),
    find: findPersonBySlackHandle,
  },
  {
    value: (h) => (nonEmpty(h.linearMemberId) ? h.linearMemberId.trim() : undefined),
    find: findPersonByLinearMemberId,
  },
  {
    value: (h) => (nonEmpty(h.jiraAccountId) ? h.jiraAccountId.trim() : undefined),
    find: findPersonByJiraAccountId,
  },
  {
    value: (h) => (nonEmpty(h.notionUserId) ? h.notionUserId.trim() : undefined),
    find: findPersonByNotionUserId,
  },
  {
    value: (h) => (nonEmpty(h.bitbucketUuid) ? h.bitbucketUuid.trim() : undefined),
    find: findPersonByBitbucketUuid,
  },
  {
    value: (h) => (nonEmpty(h.microsoftUserId) ? h.microsoftUserId.trim() : undefined),
    find: findPersonByMicrosoftUserId,
  },
  {
    value: (h) => (nonEmpty(h.discordUserId) ? h.discordUserId.trim() : undefined),
    find: findPersonByDiscordUserId,
  },
];

function findExistingPersonByHandles(db: Database, hints: PersonSyncHints): PersonRecord | null {
  for (const { value, find } of HANDLE_LOOKUPS) {
    const v = value(hints);
    if (v === undefined) {
      continue;
    }
    const p = find(db, v);
    if (p !== null) {
      return p;
    }
  }
  return null;
}

function mergeHintsIntoPerson(
  db: Database,
  id: string,
  hints: PersonSyncHints,
  options: { forceLinked: boolean },
): void {
  const cur = getPersonById(db, id);
  if (cur === null) {
    return;
  }
  const patch: Parameters<typeof updatePersonHandles>[2] = {
    displayName: hints.displayName ?? cur.displayName,
    githubLogin: hints.githubLogin ?? cur.githubLogin,
    gitlabLogin: hints.gitlabLogin ?? cur.gitlabLogin,
    slackHandle: hints.slackHandle ?? cur.slackHandle,
    linearMemberId: hints.linearMemberId ?? cur.linearMemberId,
    jiraAccountId: hints.jiraAccountId ?? cur.jiraAccountId,
    notionUserId: hints.notionUserId ?? cur.notionUserId,
    bitbucketUuid: hints.bitbucketUuid ?? cur.bitbucketUuid,
    microsoftUserId: hints.microsoftUserId ?? cur.microsoftUserId,
    discordUserId: hints.discordUserId ?? cur.discordUserId,
  };
  if (options.forceLinked) {
    patch.linked = true;
  }
  updatePersonHandles(db, id, patch);
}

function resolveHandleOnlyPerson(db: Database, hints: PersonSyncHints): string | null {
  const existing = findExistingPersonByHandles(db, hints);
  if (existing !== null) {
    mergeHintsIntoPerson(db, existing.id, hints, { forceLinked: false });
    return existing.id;
  }

  const emptyExtra = {
    bitbucketUuid: null as string | null,
    microsoftUserId: null as string | null,
    discordUserId: null as string | null,
  };

  if (nonEmpty(hints.githubLogin)) {
    const login = hints.githubLogin.trim();
    const id = uuidV5(`github:${login}`, NIMBUS_PERSON_NAMESPACE_UUID);
    insertPerson(db, {
      id,
      displayName: hints.displayName ?? login,
      canonicalEmail: null,
      githubLogin: login,
      gitlabLogin: null,
      slackHandle: null,
      linearMemberId: null,
      jiraAccountId: null,
      notionUserId: null,
      ...emptyExtra,
      linked: false,
      metadata: {},
    });
    return id;
  }
  if (nonEmpty(hints.gitlabLogin)) {
    const login = hints.gitlabLogin.trim();
    const id = uuidV5(`gitlab:${login}`, NIMBUS_PERSON_NAMESPACE_UUID);
    insertPerson(db, {
      id,
      displayName: hints.displayName ?? login,
      canonicalEmail: null,
      githubLogin: null,
      gitlabLogin: login,
      slackHandle: null,
      linearMemberId: null,
      jiraAccountId: null,
      notionUserId: null,
      ...emptyExtra,
      linked: false,
      metadata: {},
    });
    return id;
  }
  if (nonEmpty(hints.slackHandle)) {
    const h = hints.slackHandle.trim();
    const id = uuidV5(`slack:${h}`, NIMBUS_PERSON_NAMESPACE_UUID);
    insertPerson(db, {
      id,
      displayName: hints.displayName ?? h,
      canonicalEmail: null,
      githubLogin: null,
      gitlabLogin: null,
      slackHandle: h,
      linearMemberId: null,
      jiraAccountId: null,
      notionUserId: null,
      ...emptyExtra,
      linked: false,
      metadata: {},
    });
    return id;
  }
  if (nonEmpty(hints.linearMemberId)) {
    const mid = hints.linearMemberId.trim();
    const id = uuidV5(`linear:${mid}`, NIMBUS_PERSON_NAMESPACE_UUID);
    insertPerson(db, {
      id,
      displayName: hints.displayName ?? mid,
      canonicalEmail: null,
      githubLogin: null,
      gitlabLogin: null,
      slackHandle: null,
      linearMemberId: mid,
      jiraAccountId: null,
      notionUserId: null,
      ...emptyExtra,
      linked: false,
      metadata: {},
    });
    return id;
  }
  if (nonEmpty(hints.jiraAccountId)) {
    const aid = hints.jiraAccountId.trim();
    const id = uuidV5(`jira:${aid}`, NIMBUS_PERSON_NAMESPACE_UUID);
    insertPerson(db, {
      id,
      displayName: hints.displayName ?? aid,
      canonicalEmail: null,
      githubLogin: null,
      gitlabLogin: null,
      slackHandle: null,
      linearMemberId: null,
      jiraAccountId: aid,
      notionUserId: null,
      ...emptyExtra,
      linked: false,
      metadata: {},
    });
    return id;
  }
  if (nonEmpty(hints.notionUserId)) {
    const uid = hints.notionUserId.trim();
    const id = uuidV5(`notion:${uid}`, NIMBUS_PERSON_NAMESPACE_UUID);
    insertPerson(db, {
      id,
      displayName: hints.displayName ?? uid,
      canonicalEmail: null,
      githubLogin: null,
      gitlabLogin: null,
      slackHandle: null,
      linearMemberId: null,
      jiraAccountId: null,
      notionUserId: uid,
      ...emptyExtra,
      linked: false,
      metadata: {},
    });
    return id;
  }
  if (nonEmpty(hints.bitbucketUuid)) {
    const u = hints.bitbucketUuid.trim();
    const id = uuidV5(`bitbucket:${u}`, NIMBUS_PERSON_NAMESPACE_UUID);
    insertPerson(db, {
      id,
      displayName: hints.displayName ?? u,
      canonicalEmail: null,
      githubLogin: null,
      gitlabLogin: null,
      slackHandle: null,
      linearMemberId: null,
      jiraAccountId: null,
      notionUserId: null,
      bitbucketUuid: u,
      microsoftUserId: null,
      discordUserId: null,
      linked: false,
      metadata: {},
    });
    return id;
  }
  if (nonEmpty(hints.microsoftUserId)) {
    const mid = hints.microsoftUserId.trim();
    const id = uuidV5(`microsoft:${mid}`, NIMBUS_PERSON_NAMESPACE_UUID);
    insertPerson(db, {
      id,
      displayName: hints.displayName ?? mid,
      canonicalEmail: null,
      githubLogin: null,
      gitlabLogin: null,
      slackHandle: null,
      linearMemberId: null,
      jiraAccountId: null,
      notionUserId: null,
      bitbucketUuid: null,
      microsoftUserId: mid,
      discordUserId: null,
      linked: false,
      metadata: {},
    });
    return id;
  }
  if (nonEmpty(hints.discordUserId)) {
    const did = hints.discordUserId.trim();
    const id = uuidV5(`discord:${did}`, NIMBUS_PERSON_NAMESPACE_UUID);
    insertPerson(db, {
      id,
      displayName: hints.displayName ?? did,
      canonicalEmail: null,
      githubLogin: null,
      gitlabLogin: null,
      slackHandle: null,
      linearMemberId: null,
      jiraAccountId: null,
      notionUserId: null,
      bitbucketUuid: null,
      microsoftUserId: null,
      discordUserId: did,
      linked: false,
      metadata: {},
    });
    return id;
  }
  return null;
}

export function mergePeople(db: Database, personIdA: string, personIdB: string): string {
  if (personIdA === personIdB) {
    return personIdA;
  }
  const a = getPersonById(db, personIdA);
  const b = getPersonById(db, personIdB);
  if (a === null || b === null) {
    throw new Error("mergePeople: unknown person id");
  }
  const emailA = a.canonicalEmail;
  const emailB = b.canonicalEmail;
  if (emailA !== null && emailB !== null && emailA !== emailB) {
    throw new Error("mergePeople: conflicting canonical emails");
  }
  const mergedEmail = emailA ?? emailB;
  const linked = mergedEmail === null ? a.linked || b.linked : true;
  updatePersonHandles(db, personIdA, {
    displayName: a.displayName ?? b.displayName,
    canonicalEmail: mergedEmail,
    githubLogin: a.githubLogin ?? b.githubLogin,
    gitlabLogin: a.gitlabLogin ?? b.gitlabLogin,
    slackHandle: a.slackHandle ?? b.slackHandle,
    linearMemberId: a.linearMemberId ?? b.linearMemberId,
    jiraAccountId: a.jiraAccountId ?? b.jiraAccountId,
    notionUserId: a.notionUserId ?? b.notionUserId,
    bitbucketUuid: a.bitbucketUuid ?? b.bitbucketUuid,
    microsoftUserId: a.microsoftUserId ?? b.microsoftUserId,
    discordUserId: a.discordUserId ?? b.discordUserId,
    linked,
  });
  dbRun(db, "UPDATE item SET author_id = ? WHERE author_id = ?", [personIdA, personIdB]);
  deletePersonById(db, personIdB);
  return personIdA;
}
