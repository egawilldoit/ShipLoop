import { useState, type FormEvent, type ReactElement } from 'react';
import type { MvpFailure } from '../mvp-client/index.ts';
import { Field } from '../components/Field.tsx';
import { useSession } from '../session.tsx';

type SignInState = 'idle' | 'submitting' | 'failed';

/**
 * Per-field messages from a refusal, keyed by the field they belong to.
 *
 * Local rather than imported from the legacy `api-client.ts`, which this screen no longer uses
 * for anything: sign-in travels through the MVP transport, and keeping an import of the old
 * client alive only to group two arrays would keep two transports reachable from one form
 * (F01-AC1).
 */
function messagesByField(failure: MvpFailure): Readonly<Record<string, string>> {
  const grouped: Record<string, string> = {};
  for (const field of failure.fields) {
    if (grouped[field.path] === undefined) grouped[field.path] = field.message;
  }
  return grouped;
}

function describeFailure(failure: MvpFailure): string {
  switch (failure.code) {
    case 'Invalid':
      return 'Sign-in was refused. Correct the highlighted fields and try again.';
    case 'RateLimited':
      return 'Too many sign-in attempts. Wait a moment before trying again.';
    case 'Unavailable':
    // A dropped connection is grouped with an unreachable server rather than falling through to the
    // transport's own reason. That reason is written for a generic write ("nothing was changed"),
    // and it leaves an owner who was trying to sign in without being told the thing they were
    // trying to do did not happen — which is the whole reason this screen distinguishes a
    // transport failure from rejected credentials (F01-AC1, N03-AC3).
    case 'Disconnected':
      return 'The server could not be reached, so sign-in could not be completed.';
    case 'Forbidden':
    case 'Unauthorized':
      return 'That email and password combination was not accepted.';
    default:
      return failure.reason;
  }
}

/**
 * The owner's way in.
 *
 * It is a real form so Enter submits without a custom key handler (N03-AC1), and it reports
 * three visibly different states - nothing sent yet, a request in flight, and a refusal -
 * because a form that only shows a spinner cannot tell the owner whether anything happened
 * (N03-AC3).
 *
 * A rejected field's message appears beside its input rather than in the summary line, and
 * the typed values are left untouched by a failure: retyping a password to discover which
 * character was wrong is the failure mode this screen exists to avoid (F01-AC1, N03-AC3).
 */
export function SignInPage(): ReactElement {
  const { signIn } = useSession();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [errors, setErrors] = useState<Readonly<Record<string, string>>>({});
  const [summary, setSummary] = useState<string | null>(null);
  const [state, setState] = useState<SignInState>('idle');

  const submit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (state === 'submitting') return;

    const localErrors: Record<string, string> = {};
    if (email.trim() === '') localErrors['email'] = 'Enter the email address on your ShipLoop account.';
    if (password === '') localErrors['password'] = 'Enter your password.';
    if (Object.keys(localErrors).length > 0) {
      setErrors(localErrors);
      setSummary('Sign-in was not sent because required fields are empty.');
      setState('failed');
      return;
    }

    setState('submitting');
    setSummary(null);
    const failure = await signIn({ email: email.trim(), password });
    if (failure !== null) {
      setErrors(messagesByField(failure));
      setSummary(describeFailure(failure));
      setState('failed');
      return;
    }
    setErrors({});
    setPassword('');
  };

  const statusText =
    state === 'submitting' ? 'Signing in. Please wait.' : state === 'failed' ? summary : 'Signed out.';

  return (
    <main className="page page--narrow" id="main">
      <h1 className="page__title">ShipLoop owner sign-in</h1>
      <p
        className={state === 'failed' ? 'state-line state-line--error' : 'state-line'}
        role={state === 'failed' ? 'alert' : 'status'}
        aria-live={state === 'failed' ? 'assertive' : 'polite'}
        data-state={state}
      >
        {statusText}
      </p>
      <form className="form" noValidate onSubmit={(event) => void submit(event)}>
        <Field
          id="email"
          label="Email address"
          type="email"
          value={email}
          onChange={setEmail}
          autoComplete="username"
          required
          error={errors['email']}
          disabled={state === 'submitting'}
        />
        <Field
          id="password"
          label="Password"
          type="password"
          value={password}
          onChange={setPassword}
          autoComplete="current-password"
          required
          error={errors['password']}
          disabled={state === 'submitting'}
        />
        <button className="button" type="submit" disabled={state === 'submitting'}>
          {state === 'submitting' ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
    </main>
  );
}
