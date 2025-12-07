import { useState } from 'react';

interface MyReactProps {
    initialCount?: number;
}

const MyReactComponent: React.FC<MyReactProps> = ({ initialCount = 0 }) => {
    const [count, setCount] = useState(initialCount);

    return (
        <div>
            <p>Current count: {count}</p>
            <button onClick={() => setCount(count + 1)}>Increment</button>
        </div>
    );
};

export default MyReactComponent;
