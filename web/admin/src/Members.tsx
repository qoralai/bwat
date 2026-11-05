import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { getJson, nameOf, sendJson, sessionGone, type Member, messageFor, refetchOnForbidden } from './api';
import { ConnectClaude } from './ConnectClaude';

const fetchMembers = () => getJson<{ members: Member[] }>('/v1/members');

const errorCopy: Record<string, string> = {
  member_exists: 'That person is already a member.',
  domain_not_allowed: "That email isn't in a domain this install allows.",
  invalid_body: 'Enter a valid email address, like name@company.com, and a name of up to 200 characters.',
  forbidden: 'Only admins can invite people or change roles.',
  owner_required: 'Only an owner can change an owner.',
  last_owner: 'bwat needs at least one owner.',
  not_found: 'That person is no longer a member.',
  not_onboarded: 'bwat is not set up yet: the owner finishes onboarding first.',
};

// After a change, both the list and /whoami may differ (an admin can demote themself).
// They may also differ after forbidden: someone else made this admin a member, and the
// refetch takes the controls away. The two refetches are independent, so they run together.
function useMemberChange<T>(send: (input: T) => Promise<void>) {
  const queryClient = useQueryClient();
  const refetchMembersAndMe = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: ['members'] }),
      queryClient.invalidateQueries({ queryKey: ['me'] }),
    ]);
  return useMutation({
    mutationFn: send,
    onSuccess: refetchMembersAndMe,
    ...refetchOnForbidden(['members'], ['me']),
  });
}

function ChangeError({ error }: { error: Error }) {
  return (
    <p role="alert" className="error">
      {messageFor(error, errorCopy)}
    </p>
  );
}

const roleLabel = { owner: 'Owner', admin: 'Admin', member: 'Member' } as const;

type Invite = { email: string; display_name?: string };

// Owned by Members, so its error outlives the form when a forbidden refetch removes it.
function InviteForm({ add }: { add: ReturnType<typeof useMemberChange<Invite>> }) {
  return (
    <form
      className="invite"
      aria-labelledby="invite-heading"
      onSubmit={(e) => {
        e.preventDefault();
        const form = e.currentTarget;
        const data = new FormData(form);
        const email = String(data.get('email')).trim();
        const name = String(data.get('name')).trim();
        add.mutate(name ? { email, display_name: name } : { email }, {
          onSuccess: () => form.reset(),
        });
      }}
    >
      <h3 id="invite-heading">Invite a member</h3>
      <p className="muted">They sign in with this email and join as a member.</p>
      <div className="fields">
        <div className="field">
          <label htmlFor="invite-email">Email</label>
          <input id="invite-email" name="email" type="email" required autoComplete="off" />
        </div>
        <div className="field">
          <label htmlFor="invite-name">Name (optional)</label>
          <input id="invite-name" name="name" type="text" autoComplete="off" />
        </div>
        <button type="submit" className="button primary" disabled={add.isPending}>
          Invite
        </button>
      </div>
      {add.isError && <ChangeError error={add.error} />}
      <p role="status" className="muted">
        {add.isSuccess && `Added ${add.variables.email}. They can now sign in.`}
      </p>
    </form>
  );
}

export function Members({ canManage }: { canManage: boolean }) {
  const list = useQuery({ queryKey: ['members'], queryFn: fetchMembers });
  const changeRole = useMemberChange(({ id, role }: { id: string; role: Member['role'] }) =>
    sendJson('PATCH', `/v1/members/${id}`, { role }),
  );
  const add = useMemberChange((input: Invite) => sendJson('POST', '/v1/members', input));
  return (
    <section className="members">
      <h2 id="members-heading">Members</h2>
      {list.isPending && (
        <p role="status" className="muted">
          Loading members…
        </p>
      )}
      {list.error && !sessionGone(list.error) && <ChangeError error={list.error} />}
      {changeRole.isError && <ChangeError error={changeRole.error} />}
      {list.data && (
        <div className="table-wrap">
          <table aria-labelledby="members-heading">
            <thead>
              <tr>
                <th scope="col">Name</th>
                <th scope="col">Email</th>
                <th scope="col">Role</th>
                {canManage && <th scope="col">Change role</th>}
              </tr>
            </thead>
            <tbody>
              {list.data.members.map((m) => (
                <tr key={m.id}>
                  <td id={`member-${m.id}`} className="name">
                    {nameOf(m)}
                  </td>
                  <td>{m.email}</td>
                  <td>
                    <span className={`role ${m.role}`}>{roleLabel[m.role]}</span>
                  </td>
                  {canManage && (
                    <td>
                      {m.role !== 'owner' && (
                        <button
                          type="button"
                          className="button"
                          aria-describedby={`member-${m.id}`}
                          disabled={changeRole.isPending}
                          onClick={() => changeRole.mutate({ id: m.id, role: m.role === 'admin' ? 'member' : 'admin' })}
                        >
                          {m.role === 'admin' ? 'Make member' : 'Make admin'}
                        </button>
                      )}
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {canManage && <InviteForm add={add} />}
      <ConnectClaude ready={!list.isPending} />
    </section>
  );
}
