import type { ComponentProps } from 'react';

import { Avatar } from '@/components/ui/Avatar';
import { GroupIcon } from '@/components/ui/GroupIcon';

import { usePhotoUrl } from './photo-urls';

/**
 * The avatar with the person's photo when there is one and this person may
 * see it (0030); the initials otherwise. The invitation page keeps the plain
 * Avatar: a visitor sees no one's photo there.
 */
export function PhotoAvatar(props: Omit<ComponentProps<typeof Avatar>, 'photo'>) {
  const photo = usePhotoUrl('profile', props.id);
  return <Avatar {...props} photo={photo} />;
}

/**
 * The group's photo for its active members, the icon otherwise. The
 * invitation page keeps the plain GroupIcon: its preview shows only the icon
 * and the colour.
 */
export function GroupPhotoIcon({
  groupId,
  ...props
}: Omit<ComponentProps<typeof GroupIcon>, 'photo'> & { groupId: string }) {
  const photo = usePhotoUrl('group', groupId);
  return <GroupIcon {...props} photo={photo} />;
}
