/**
 * The four MVP surfaces, and the two retired ones, behind one switch.
 *
 * Split out of `App.tsx` so the shell holds nothing but the header, the connection banner and this.
 * The retired surfaces are mounted from the same place on purpose: they are reachable by address
 * (`#/legacy/<name>`) so the browser specs that still prove them keep driving them, while the
 * header offers only the four MVP tabs. That separation is the whole of "hide the advanced pages"
 * — a page that is only reachable by knowing its address is not part of the product's navigation.
 */

import type { ReactElement } from 'react';
import type { ProjectSummary } from '../api-client.ts';
import { BriefPage } from '../pages/BriefPage.tsx';
import { ConnectorsPage } from '../pages/ConnectorsPage.tsx';
import { DashboardPage } from '../pages/DashboardPage.tsx';
import { IntakePage } from '../pages/IntakePage.tsx';
import { PlanPage } from '../pages/PlanPage.tsx';
import { ProfilesPage } from '../pages/ProfilesPage.tsx';
import { PublicationPage } from '../pages/PublicationPage.tsx';
import { ReviewCardPage } from '../pages/ReviewCardPage.tsx';
import { RunPage } from '../pages/RunPage.tsx';
import { ContractPage } from './pages/ContractPage.tsx';
import { HandoffPage } from './pages/HandoffPage.tsx';
import { HomePage } from './pages/HomePage.tsx';
import { NewRequestPage } from './pages/NewRequestPage.tsx';
import { ReviewPage } from './pages/ReviewPage.tsx';
import { SettingsPage } from './pages/SettingsPage.tsx';
import type { Route } from './navigation.ts';

export interface SurfaceProps {
  readonly route: Route;
  readonly projectId: string | null;
  readonly epoch: number;
  readonly navigate: (hash: string) => void;
  readonly projects: readonly ProjectSummary[];
  readonly selectProject: (projectId: string) => void;
  readonly reloadProjects: () => void;
  /**
   * The selections the retired surfaces share.
   *
   * Held by the shell rather than by any one of them, for the reason it always has been: intake,
   * brief, plan and publication are four views of one captured request, and the run and its review
   * card are two views of one run. A per-page selection would let one of them act on a thing the
   * other is not showing.
   */
  readonly legacySelection: {
    readonly ideaId: string;
    readonly profileId: string;
    readonly profileLabel: string;
    readonly jobId: string;
    readonly planId: string;
    setIdeaId: (value: string) => void;
    setProfile: (id: string, label: string) => void;
    setJobId: (value: string) => void;
    setPlanId: (value: string) => void;
  };
}

/** `LegacySurface` with its route narrowed, so the section switch is exhaustive and typed. */
interface LegacyProps extends Omit<SurfaceProps, 'route'> {
  readonly route: Extract<Route, { readonly kind: 'legacy' }>;
}

/**
 * Fails the build rather than the page when a legacy surface is added without a case here.
 *
 * The point is that `LEGACY_SECTIONS` and this switch are checked against each other by the type
 * checker, so a new retired surface cannot be addressable and unrenderable at the same time.
 */
function assertNever(value: never): never {
  throw new Error(`Unreachable owner surface: ${String(value)}`);
}

function LegacySurface({ route, projectId, epoch, navigate, legacySelection }: LegacyProps): ReactElement {
  const { ideaId, profileId, profileLabel, jobId, planId } = legacySelection;
  switch (route.section) {
    case 'profiles':
      return (
        <ProfilesPage
          projectId={projectId}
          activeProfileId={profileId}
          onSelectProfile={legacySelection.setProfile}
          epoch={epoch}
        />
      );
    case 'connectors':
      return (
        <ConnectorsPage projectId={projectId} profileId={profileId} profileName={profileLabel} epoch={epoch} />
      );
    case 'intake':
      return (
        <IntakePage
          selectedIdeaId={ideaId}
          selectedProjectId={projectId}
          onSelectIdea={legacySelection.setIdeaId}
          onOpenBrief={(next) => {
            legacySelection.setIdeaId(next);
            navigate('#/legacy/brief');
          }}
          epoch={epoch}
        />
      );
    case 'brief':
      return (
        <BriefPage
          ideaId={ideaId}
          onBackToIntake={() => navigate('#/legacy/intake')}
          epoch={epoch}
        />
      );
    case 'runs':
      return (
        <RunPage
          selectedJobId={jobId}
          onSelectJob={legacySelection.setJobId}
          onOpenReviewCard={(next) => {
            legacySelection.setJobId(next);
            navigate('#/legacy/review-card');
          }}
          epoch={epoch}
        />
      );
    case 'review-card':
      return (
        <ReviewCardPage jobId={jobId} onBackToRuns={() => navigate('#/legacy/runs')} epoch={epoch} />
      );
    case 'dashboard':
      return <DashboardPage epoch={epoch} />;
    case 'plan':
      return (
        <PlanPage
          ideaId={ideaId}
          onOpenPublication={(next) => {
            legacySelection.setPlanId(next);
            navigate('#/legacy/publication');
          }}
          epoch={epoch}
        />
      );
    case 'publication':
      return (
        <PublicationPage
          planId={planId}
          ideaId={ideaId}
          projectId={projectId}
          onBackToPlan={() => navigate('#/legacy/plan')}
          epoch={epoch}
        />
      );
    default:
      return assertNever(route.section);
  }
}

export function Surface(props: SurfaceProps): ReactElement {
  const { route, projectId, epoch, navigate, projects, selectProject, reloadProjects } = props;

  switch (route.kind) {
    case 'home':
      return (
        <HomePage
          projectId={projectId}
          epoch={epoch}
          onNewRequest={() => navigate('#/new-request')}
          onOpenContract={(contractId) => navigate(`#/contracts/${encodeURIComponent(contractId)}`)}
          onOpenReview={(candidateId) => navigate(`#/review/${encodeURIComponent(candidateId)}`)}
        />
      );
    case 'new-request':
      return (
        <NewRequestPage
          projectId={projectId}
          onCreated={(contractId) => navigate(`#/contracts/${encodeURIComponent(contractId)}`)}
        />
      );
    case 'contract':
      return (
        <ContractPage
          contractId={route.contractId}
          epoch={epoch}
          onPrepareImplementation={(contractId) => navigate(`#/handoff/${encodeURIComponent(contractId)}`)}
        />
      );
    case 'handoff':
      return (
        <HandoffPage
          contractId={route.contractId}
          epoch={epoch}
          onLinked={(candidateId) => navigate(`#/review/${encodeURIComponent(candidateId)}`)}
        />
      );
    case 'review':
      return (
        <ReviewPage
          projectId={projectId}
          candidateId={route.candidateId}
          epoch={epoch}
          onOpenCandidate={(candidateId) => navigate(`#/review/${encodeURIComponent(candidateId)}`)}
          onBackToQueue={() => navigate('#/review')}
        />
      );
    case 'settings':
      return (
        <SettingsPage
          projects={projects}
          selectedProjectId={projectId}
          epoch={epoch}
          onSelectProject={selectProject}
          onProjectsChanged={reloadProjects}
        />
      );
    case 'legacy':
      return LegacySurface({ ...props, route });
  }
}