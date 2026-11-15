import { ArrowRight, ArrowUpRight, Bot, FolderKanban, House, Link2, MonitorSmartphone, Plus, Sparkles, Users } from 'lucide-react';
import type { CloudRoom } from './cloudRooms';
import './workspaceHome.css';

type Props = {
  rooms: CloudRoom[];
  onOpenGroup: (id: string) => void;
  onCreateGroup: () => void;
  onJoinGroup: () => void;
  backroomHref: string;
};

function createdLabel(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? 'Recently created'
    : 'Created ' + date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

export default function WorkspaceHome({
  rooms, onOpenGroup, onCreateGroup, onJoinGroup, backroomHref,
}: Props) {
  return <section className="rm-workspace-home">
    <header className="rm-workspace-hero">
      <div className="rm-workspace-hero-copy">
        <span className="rm-workspace-eyebrow"><Sparkles size={14}/> YOUR COLLABORATIVE WORKSPACE</span>
        <h1>More minds.<br/><em>Meaningful progress.</em></h1>
        <p>Bring people and the AI conversations they already use into shared environments for thinking, learning, researching, and building together.</p>
        <div className="rm-workspace-actions">
          <button className="rm-workspace-primary" onClick={onCreateGroup}><Plus size={16}/> Create a group</button>
          <button className="rm-workspace-secondary" onClick={onJoinGroup}><Link2 size={16}/> Join with invitation</button>
        </div>
      </div>
      <div className="rm-workspace-hero-art" aria-hidden="true">
        <div className="rm-workspace-orbit rm-orbit-one"/>
        <div className="rm-workspace-orbit rm-orbit-two"/>
        <div className="rm-workspace-orbit rm-orbit-three"/>
        <span className="rm-workspace-orbit-core"><Sparkles size={28}/></span>
        <span className="rm-workspace-node rm-node-people"><Users size={15}/> People</span>
        <span className="rm-workspace-node rm-node-ai"><Bot size={15}/> AI sessions</span>
        <span className="rm-workspace-node rm-node-work"><FolderKanban size={15}/> Projects</span>
      </div>
    </header>

    <div className="rm-workspace-highlights">
      <article className="rm-workspace-highlight">
        <span className="rm-workspace-highlight-icon"><Users size={19}/></span>
        <div><span className="rm-workspace-highlight-label">Your groups</span><strong>{rooms.length}</strong><p>{rooms.length === 1 ? 'collaborative environment' : 'collaborative environments'} available to you</p></div>
      </article>
      <a className="rm-workspace-highlight rm-workspace-highlight-link" href={backroomHref}>
        <span className="rm-workspace-highlight-icon"><MonitorSmartphone size={19}/></span>
        <div><span className="rm-workspace-highlight-label">Backroom</span><strong>Virtual devices</strong><p>Open the current device workspace and connection experiments</p><span className="rm-workspace-highlight-cta">Open Backroom <ArrowUpRight size={14}/></span></div>
      </a>
      <article className="rm-workspace-highlight">
        <span className="rm-workspace-highlight-icon"><FolderKanban size={19}/></span>
        <div><span className="rm-workspace-highlight-label">Project organisation</span><strong>Taking shape</strong><p>Projects will work inside team groups or independently. Dedicated project management is not yet implemented.</p></div>
      </article>
    </div>

    <section className="rm-workspace-groups">
      <div className="rm-workspace-section-heading">
        <div><span className="rm-workspace-eyebrow">YOUR COLLABORATIVE ENVIRONMENTS</span><h2>Groups</h2><p>Choose a group to continue working with its people, AI sessions, conversations, and shared knowledge.</p></div>
        <button className="rm-workspace-secondary" onClick={onCreateGroup}><Plus size={15}/> New group</button>
      </div>
      {rooms.length ? <div className="rm-workspace-group-grid">
        {rooms.map(group => <button type="button" key={group.id} className="rm-workspace-group-card" onClick={() => onOpenGroup(group.id)}>
          <span className="rm-workspace-group-top"><span className="rm-workspace-group-icon"><Users size={18}/></span><ArrowUpRight size={16}/></span>
          <span className="rm-workspace-group-title">{group.title}</span>
          <span className="rm-workspace-group-description">{group.objective || 'A shared environment for people and AI collaborators.'}</span>
          <span className="rm-workspace-group-meta">{createdLabel(group.created_at)}</span>
          <span className="rm-workspace-group-open">Open group <ArrowRight size={14}/></span>
        </button>)}
      </div> : <div className="rm-workspace-empty">
        <span className="rm-workspace-empty-icon"><House size={22}/></span>
        <h3>Your collaborative world starts here</h3>
        <p>Create a team or project-focused group, or join an existing group with an invitation. You can bring human collaborators and supported AI participants together inside it.</p>
        <div><button className="rm-workspace-primary" onClick={onCreateGroup}><Plus size={16}/> Create your first group</button><button className="rm-workspace-secondary" onClick={onJoinGroup}><Link2 size={15}/> Join a group</button></div>
      </div>}
    </section>
  </section>;
}
