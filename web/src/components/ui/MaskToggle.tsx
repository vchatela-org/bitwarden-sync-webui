import { Eye, EyeOff } from 'lucide-react';
import { Button } from './Button.js';
import { Tooltip } from './Feedback.js';

interface Props {
  masked: boolean;
  onToggle: () => void;
}

/** Toggles display-only redaction of emails and vault item details — for taking safe screenshots. */
export function MaskToggle({ masked, onToggle }: Props) {
  return (
    <Tooltip content={masked ? 'Sensitive data hidden — click to reveal' : 'Hide emails and item details for screenshots'}>
      <Button
        size="sm"
        variant={masked ? 'default' : 'ghost'}
        icon={masked ? <EyeOff /> : <Eye />}
        onClick={onToggle}
        aria-pressed={masked}
      >
        {masked ? 'Masked' : 'Mask'}
      </Button>
    </Tooltip>
  );
}
